/**
 * Persona chat: talk with someone as the owner's own notes show them — their
 * correspondence with the owner, and what the owner's journal says of them —
 * in a period of the owner's life the owner chooses, or with a persona the
 * owner describes, or with one of the personas made for the owner (their
 * future self, their younger self, a listener, a new friend, Ariadne, a
 * companion), which talk from a profile of the owner and remember every
 * conversation. A persona is made once, by reading and compressing those
 * notes into an agent-made note, and is not shown here: only talked with.
 * A cloud model can be chosen, and then the private notes leave the owner's
 * devices: said plainly, and asked first.
 */
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { ModelChoice } from "../batch/card";
import type { Era } from "./eras";
import type { Person } from "./people";
import { CLOSENESS_STEPS, PREMADE, premade, type ConversationRecord, type Premade, type PremadeId } from "./premade";
import type { Reply, Turn } from "./talk";

export const PERSONA_VIEW_TYPE = "ariadne-persona";
/** The people offered: those there is most to know them by. */
export const MAX_PEOPLE = 20;

const FREE = "__describe";
const ALL = "__all";
const MADE = "made:";
/** The closeness question comes after this many of the owner's messages. */
const ASK_CLOSENESS_AFTER = 3;

export interface PersonaState {
  name: string;
  /** Where the persona note is, or would be. */
  path: string;
  /** A persona note exists for this person and period. */
  ready: boolean;
  /** It was made before newer conversations came. */
  stale: boolean;
  built?: string;
  /** What making it would read. */
  conversations: number;
  read: number;
  batches: number;
  /** Notes never shown to any model (sealed or excluded). */
  withheld: number;
}

export interface Persona {
  name: string;
  system: string;
  chars: number;
}

export interface PremadePersona extends Persona {
  /** The unseen first turn when the persona begins. */
  opener: string;
  /** Days since the last conversation with it. */
  since?: number;
}

export interface PersonaViewDeps {
  /** Everyone the owner has written with, the one there is most to know them by first. */
  people(): Person[];
  choices(): Promise<ModelChoice[]>;
  route: { get(): string; set(route: string): void };
  /** The periods of the owner's life with someone that each have enough to go on — empty when there is one. */
  eras(person: Person): Promise<Era[]>;
  state(person: Person, era: Era | undefined, route: string): Promise<PersonaState>;
  /** Read their notes and write the persona note. */
  make(person: Person, era: Era | undefined, route: string, progress: (done: number, of: number) => void, cancelled: () => boolean): Promise<void>;
  persona(opts: { person?: Person; description?: string; era?: Era; route: string }): Promise<Persona>;
  talk(route: string, persona: Persona, turns: Turn[]): Promise<Reply>;
  /** For a cloud model: about what a conversation, and making the persona, cost. */
  estimate(route: string, chars: number): { first: number; next: number } | undefined;
  makeEstimate(route: string, batches: number): number | undefined;
  /** Why this cannot be used now (a setting), or undefined. */
  blocked(): string | undefined;
  /** What the personas made for the owner call them. */
  owner: { get(): string; set(name: string): void };
  /** The periods of the owner's life their own writing can speak for. */
  selfEras(): Promise<Era[]>;
  /** The owner's profile, which the personas made for them talk from: of all of it, or of a period. */
  selfState(era: Era | undefined, route: string): Promise<PersonaState>;
  makeSelf(era: Era | undefined, route: string, progress: (done: number, of: number) => void, cancelled: () => boolean): Promise<void>;
  premade(id: PremadeId, era: Era | undefined, route: string): Promise<PremadePersona>;
  /** Keep a conversation with a persona made for the owner, so that it remembers. */
  saveConversation(rec: ConversationRecord): Promise<string>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const years = (p: Person) => (p.first ? (p.first.slice(0, 4) === p.last.slice(0, 4) ? p.first.slice(0, 4) : `${p.first.slice(0, 4)}–${p.last.slice(0, 4)}`) : "");

export class PersonaView extends ItemView {
  private people: Person[] = [];
  private choices: ModelChoice[] = [];
  private eras: Era[] = [];
  private state?: PersonaState;
  private persona?: Persona;
  private turns: Turn[] = [];
  /** A conversation with a persona made for the owner, as it is kept. */
  private record?: ConversationRecord;
  private askedCloseness = false;
  private busy = false;
  private making = false;
  private stopMaking = false;
  private progress = "";
  private consent = false;
  private error = "";
  /** Each refresh gets a number: an older one that finishes late is dropped. */
  private generation = 0;

  private personEl!: HTMLSelectElement;
  private eraRow!: HTMLElement;
  private eraEl!: HTMLSelectElement;
  private modelEl!: HTMLSelectElement;
  private describeEl!: HTMLTextAreaElement;
  private describeRow!: HTMLElement;
  private infoEl!: HTMLElement;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: PersonaViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PERSONA_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Persona chat";
  }

  getIcon(): string {
    return "users";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add("ariadne", "ariadne-chat", "ariadne-persona");
    const head = root.createDiv({ cls: "ariadne-persona-head" });
    const row = (label: string) => {
      const r = head.createDiv({ cls: "ariadne-persona-row" });
      r.createSpan({ cls: "ariadne-persona-label", text: label });
      return r;
    };
    this.personEl = row("Persona").createEl("select", { cls: "dropdown" });
    this.eraRow = row("Period");
    this.eraEl = this.eraRow.createEl("select", { cls: "dropdown" });
    this.eraRow.hide();
    this.modelEl = row("Model").createEl("select", { cls: "dropdown" });
    this.describeRow = head.createDiv({ cls: "ariadne-persona-describe" });
    this.describeEl = this.describeRow.createEl("textarea", { attr: { rows: "3", placeholder: "Describe the persona: who they are to you, how they talk, what they care about…" } });
    this.describeRow.hide();
    this.infoEl = head.createDiv({ cls: "ariadne-persona-info" });

    this.listEl = root.createDiv({ cls: "ariadne-chat-list" });
    const form = root.createDiv({ cls: "ariadne-chat-form" });
    this.inputEl = form.createEl("textarea", { cls: "ariadne-chat-input", attr: { rows: "4", placeholder: "Write to them…" } });
    const bottom = form.createDiv({ cls: "ariadne-chat-form-row" });
    const fresh = bottom.createEl("button", { text: "New conversation" });
    this.sendEl = bottom.createEl("button", { cls: "mod-cta", text: "Send" });

    this.personEl.addEventListener("change", () => void this.personChanged());
    this.eraEl.addEventListener("change", () => void this.refresh());
    this.modelEl.addEventListener("change", () => {
      this.deps.route.set(this.modelEl.value);
      void this.refresh();
    });
    this.describeEl.addEventListener("change", () => void this.refresh());
    fresh.addEventListener("click", () => this.restart("New conversation."));
    this.sendEl.addEventListener("click", () => void this.send());
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void this.send();
      }
    });

    this.fillPeople();
    await this.fillModels();
    this.render();
  }

  async onClose(): Promise<void> {
    this.stopMaking = true;
    this.contentEl.replaceChildren();
  }

  private fillPeople(): void {
    const keep = this.personEl.value;
    this.people = this.deps.people().slice(0, MAX_PEOPLE);
    const owner = this.deps.owner.get().trim() || "You";
    const sel = this.personEl;
    sel.replaceChildren();
    sel.createEl("option", { value: "", text: "Choose someone…" });
    const made = sel.createEl("optgroup", { attr: { label: "Made for you" } });
    for (const m of PREMADE) made.createEl("option", { value: `${MADE}${m.id}`, text: m.label(owner) });
    const people = sel.createEl("optgroup", { attr: { label: this.people.length ? "People you have written with" : "No correspondence found" } });
    for (const p of this.people) {
      const detail = [p.messages ? plural(p.messages, "message") : plural(p.moments.length, "conversation"), years(p)].filter(Boolean).join(", ");
      people.createEl("option", { value: p.key, text: `${p.name}${detail ? ` — ${detail}` : ""}` });
    }
    sel.createEl("option", { value: FREE, text: "Describe someone yourself…" });
    if (keep) sel.value = keep;
  }

  private async fillModels(): Promise<void> {
    this.modelEl.replaceChildren();
    this.modelEl.createEl("option", { value: "", text: "Looking for models…" });
    this.modelEl.disabled = true;
    try {
      this.choices = await this.deps.choices();
    } catch {
      this.choices = [];
    }
    this.modelEl.replaceChildren();
    this.modelEl.disabled = false;
    if (this.choices.length === 0) {
      this.modelEl.createEl("option", { value: "", text: "No model reachable" });
      return;
    }
    const local = this.choices.filter((c) => !c.cloud);
    const cloud = this.choices.filter((c) => c.cloud);
    if (local.length) {
      const g = this.modelEl.createEl("optgroup", { attr: { label: "On your machines — your notes stay with you" } });
      for (const c of local) g.createEl("option", { value: c.route, text: c.label });
    }
    if (cloud.length) {
      const g = this.modelEl.createEl("optgroup", { attr: { label: "⚠ Cloud — sends your private notes to Anthropic" } });
      for (const c of cloud) g.createEl("option", { value: c.route, text: `⚠ ${c.label}`, cls: "ariadne-persona-cloud-option" });
    }
    const saved = this.deps.route.get();
    this.modelEl.value = this.choices.some((c) => c.route === saved) ? saved : (local[0] ?? cloud[0])!.route;
  }

  private chosen(): ModelChoice | undefined {
    return this.choices.find((c) => c.route === this.modelEl.value);
  }

  private person(): Person | undefined {
    return this.people.find((p) => p.key === this.personEl.value);
  }

  /** A persona made for the owner, when one is chosen. */
  private made(): Premade | undefined {
    const v = this.personEl.value;
    return v.startsWith(MADE) ? premade(v.slice(MADE.length)) : undefined;
  }

  private era(): Era | undefined {
    if (this.made()) return this.made()!.period && this.eras.length >= 2 ? this.eras[Number(this.eraEl.value)] : undefined;
    return this.person() && this.eras.length >= 2 && this.eraEl.value !== ALL ? this.eras[Number(this.eraEl.value)] : undefined;
  }

  private async personChanged(): Promise<void> {
    this.describeRow.toggle(this.personEl.value === FREE);
    this.eras = [];
    this.eraRow.hide();
    const p = this.person();
    const m = this.made();
    if (m?.period) {
      this.eraRow.show();
      this.eraEl.replaceChildren();
      this.eraEl.createEl("option", { value: "0", text: "Looking for periods with enough of your writing…" });
      this.eraEl.disabled = true;
      const asked = this.personEl.value;
      const eras = await this.deps.selfEras().catch(() => [] as Era[]);
      if (this.personEl.value !== asked) return;
      this.eras = eras;
      this.eraEl.disabled = false;
      this.eraEl.replaceChildren();
      eras.forEach((e, i) => this.eraEl.createEl("option", { value: String(i), text: e.label }));
      this.eraRow.toggle(eras.length >= 2);
    } else if (p && p.moments.length >= 16) {
      this.eraRow.show();
      this.eraEl.replaceChildren();
      this.eraEl.createEl("option", { value: ALL, text: "Looking for periods with enough to go on…" });
      this.eraEl.disabled = true;
      const asked = p.key;
      const eras = await this.deps.eras(p).catch(() => [] as Era[]);
      if (this.person()?.key !== asked) return;
      this.eras = eras;
      this.eraEl.disabled = false;
      this.eraEl.replaceChildren();
      this.eraEl.createEl("option", { value: ALL, text: `All of it${years(p) ? ` (${years(p)})` : ""}` });
      eras.forEach((e, i) => this.eraEl.createEl("option", { value: String(i), text: e.label }));
      this.eraRow.toggle(eras.length >= 2);
    }
    await this.refresh();
  }

  /** The era a profile of the owner is made for: a younger self's period, or none. */
  private selfEra(): Era | undefined {
    return this.made()?.period ? this.era() : undefined;
  }

  /** What is chosen now: is there a persona for it, and what would making one take. A new choice starts a new conversation. */
  private async refresh(): Promise<void> {
    const gen = ++this.generation;
    this.consent = false;
    this.error = "";
    this.state = undefined;
    this.persona = undefined;
    this.record = undefined;
    this.askedCloseness = false;
    const p = this.person();
    const m = this.made();
    const choice = this.chosen();
    const hadTalk = this.turns.length > 0;
    this.turns = [];
    this.listEl.empty();
    if (choice && (p || (m && this.deps.owner.get().trim()))) {
      this.render(p ? `Looking at what your notes hold about ${p.name}…` : "Looking at your writing…");
      try {
        const state = p ? await this.deps.state(p, this.era(), choice.route) : await this.deps.selfState(this.selfEra(), choice.route);
        if (gen !== this.generation) return;
        this.state = state;
      } catch (err) {
        if (gen !== this.generation) return;
        this.error = err instanceof Error ? err.message : "error";
      }
    }
    if (hadTalk) this.listEl.createDiv({ cls: "ariadne-chat-note", text: "New conversation." });
    this.render();
  }

  /** A new conversation: the persona is put together again, so a persona made for the owner remembers the one just had. */
  private restart(note?: string): void {
    this.turns = [];
    this.persona = undefined;
    this.record = undefined;
    this.askedCloseness = false;
    this.listEl.empty();
    if (note) this.listEl.createDiv({ cls: "ariadne-chat-note", text: note });
    this.render();
  }

  private async make(): Promise<void> {
    const p = this.person();
    const m = this.made();
    const choice = this.chosen();
    if ((!p && !m) || !choice || this.making) return;
    if (choice.cloud && !this.consent) {
      new Notice("Tick “Send them to Anthropic” first, or pick a model on your machines.");
      return;
    }
    const gen = this.generation;
    this.making = true;
    this.stopMaking = false;
    this.progress = "Starting…";
    this.render();
    const progress = (done: number, of: number) => {
      this.progress = done < of - 1 ? `Reading part ${done + 1} of ${of - 1}…` : "Summing up…";
      if (gen === this.generation) this.render();
    };
    const cancelled = () => this.stopMaking || gen !== this.generation;
    try {
      if (p) {
        await this.deps.make(p, this.era(), choice.route, progress, cancelled);
        if (gen !== this.generation) return;
        this.state = await this.deps.state(p, this.era(), choice.route);
        new Notice(`The persona for ${p.name} is made.`);
      } else {
        await this.deps.makeSelf(this.selfEra(), choice.route, progress, cancelled);
        if (gen !== this.generation) return;
        this.state = await this.deps.selfState(this.selfEra(), choice.route);
        new Notice("Your profile is made.");
      }
    } catch (err) {
      if (gen === this.generation) this.error = `Not made: ${err instanceof Error ? err.message : "error"}`;
    } finally {
      this.making = false;
      this.progress = "";
      if (gen === this.generation) this.render();
    }
  }

  private ready(): boolean {
    const free = this.personEl.value === FREE && this.describeEl.value.trim().length > 0;
    return free || !!this.state?.ready;
  }

  /** "Recreate from sources", and a link to the note it is kept in. */
  private remakeRow(s: PersonaState, label: string): void {
    const row = this.infoEl.createDiv({ cls: "ariadne-persona-actions" });
    const again = row.createEl("button", { text: "Recreate from sources" });
    again.addEventListener("click", () => void this.make());
    const open = row.createEl("a", { cls: "ariadne-persona-open", text: label, href: "#", attr: { title: s.path } });
    open.addEventListener("click", (e) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(s.path, "", "tab");
    });
  }

  /** The setup lines, the warning for a cloud model, and what to do next — never the persona itself. */
  private render(working?: string): void {
    this.infoEl.empty();
    const blocked = this.deps.blocked();
    const choice = this.chosen();
    const p = this.person();
    const m = this.made();
    const s = this.state;
    const note = (text: string, cls = "ariadne-chat-note") => this.infoEl.createDiv({ cls, text });
    this.modelEl.toggleClass("is-cloud", !!choice?.cloud);
    const canSend = () => !this.busy && !this.making && !!choice && this.ready() && !(choice.cloud && !this.consent);
    if (blocked) {
      note(blocked, "ariadne-persona-warn");
      this.sendEl.disabled = true;
      return;
    }
    if (working) note(working);
    else if (this.error) note(this.error, "ariadne-persona-warn");
    const owner = this.deps.owner.get().trim();
    const model = choice?.label.replace(/ — .*$/, "") ?? "the model";

    if (this.personEl.value === FREE) {
      note(this.describeEl.value.trim() ? "A simulation from your description — not a real person." : "Describe the persona above, then write to them.");
    } else if (m && !owner) {
      note("What should they call you?");
      const row = this.infoEl.createDiv({ cls: "ariadne-persona-actions" });
      const input = row.createEl("input", { type: "text", attr: { placeholder: "Your first name" } });
      const save = row.createEl("button", { cls: "mod-cta", text: "Save" });
      const done = () => {
        if (!input.value.trim()) return;
        this.deps.owner.set(input.value);
        this.fillPeople();
        void this.refresh();
      };
      save.addEventListener("click", done);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") done();
      });
    } else if (m && s) {
      const era = this.selfEra();
      note(m.blurb(owner));
      if (this.making) {
        const line = note(`Making your profile${era ? ` for ${era.label}` : ""}: ${this.progress}`);
        const stop = line.createEl("button", { cls: "ariadne-persona-inline", text: "Stop" });
        stop.addEventListener("click", () => {
          this.stopMaking = true;
        });
      } else if (s.ready) {
        note(`Ready: ${m.name(owner, era)} is a simulation, talking from your profile${era ? ` of ${era.label}` : ""} (made ${s.built ?? "earlier"})${m.recent ? ", your recent journal," : ""} and your earlier conversations with them.`, "ariadne-persona-made");
        if (s.stale) note("You have written a good deal more since your profile was made.");
        this.remakeRow(s, era ? `Open your profile of ${era.label}` : "Open your profile");
        if (this.turns.length === 0 && !this.busy) {
          const begin = this.infoEl.createEl("button", { cls: "mod-cta ariadne-persona-inline", text: `Let ${m.name(owner, era)} begin` });
          begin.disabled = !canSend();
          begin.addEventListener("click", () => void this.exchange(undefined));
        }
      } else {
        const minutes = Math.max(1, Math.round(s.batches * 0.75));
        const cost = choice?.cloud ? this.deps.makeEstimate(choice.route, s.batches) : undefined;
        const reads = s.read === s.conversations ? `your side of ${plural(s.conversations, "conversation")}` : `your side of ${s.read} of ${s.conversations} conversations, spread across the years,`;
        note(
          s.batches
            ? `The personas made for you talk from a profile of you${era ? ` in ${era.label}` : ""}, made first: ${model} reads ${reads}, your journal${era ? "" : " and your notes"}${cost !== undefined ? ` (about $${cost.toFixed(2)})` : ` (about ${plural(minutes, "minute")})`}, and keeps what it learns in a note in Personal/Correspondence/Personas.`
            : `There is not enough of your own writing${era ? ` from ${era.label}` : ""} to make a profile from.`,
        );
        if (s.batches) {
          const go = this.infoEl.createEl("button", { cls: "mod-cta ariadne-persona-inline", text: era ? `Make your profile of ${era.label}` : "Make your profile" });
          go.disabled = !!choice?.cloud && !this.consent;
          go.addEventListener("click", () => void this.make());
        }
      }
      if (s.withheld) note(`${plural(s.withheld, "note")} of yours ${s.withheld === 1 ? "is" : "are"} never shown to any model (sealed or excluded).`);
    } else if (!p && !m) {
      note("Choose a persona made for you, someone you have written with, or describe someone — and a model.");
    } else if (p && s) {
      if (this.making) {
        const line = note(`Making the persona for ${s.name}: ${this.progress}`);
        const stop = line.createEl("button", { cls: "ariadne-persona-inline", text: "Stop" });
        stop.addEventListener("click", () => {
          this.stopMaking = true;
        });
      } else if (s.ready) {
        note(`Ready: a simulation of ${s.name}, made from your notes${s.built ? ` on ${s.built}` : ""} — not ${s.name}.`, "ariadne-persona-made");
        if (s.stale) note(`There are newer conversations with ${s.name} than the persona was made from.`);
        this.remakeRow(s, "Open the persona note");
      } else {
        const minutes = Math.max(1, Math.round(s.batches * 0.75));
        const cost = choice?.cloud ? this.deps.makeEstimate(choice.route, s.batches) : undefined;
        const reads = s.read === s.conversations ? plural(s.conversations, "conversation") : `${s.read} of ${s.conversations} conversations, spread across the years,`;
        note(
          s.batches
            ? `To talk with ${s.name}, a persona is made first: ${model} reads ${reads} and what your notes say of them${cost !== undefined ? ` (about $${cost.toFixed(2)})` : ` (about ${plural(minutes, "minute")})`}, and keeps what it learns in a note in Personal/Correspondence/Personas.`
            : `Your notes hold nothing about ${s.name} to make a persona from.`,
        );
        if (s.batches) {
          const go = this.infoEl.createEl("button", { cls: "mod-cta ariadne-persona-inline", text: "Make the persona" });
          go.disabled = !!choice?.cloud && !this.consent;
          go.addEventListener("click", () => void this.make());
        }
      }
      if (s.withheld) note(`${plural(s.withheld, "note")} about them ${s.withheld === 1 ? "is" : "are"} never shown to any model (sealed or excluded).`);
    }

    const shown = p || this.personEl.value === FREE || (m && owner);
    if (choice?.cloud && shown) {
      const warn = this.infoEl.createDiv({ cls: "ariadne-persona-cloud" });
      warn.createDiv({ cls: "ariadne-persona-cloud-title", text: "⚠ Your private notes would leave your devices" });
      const est = this.persona ? this.deps.estimate(choice.route, this.persona.chars) : undefined;
      const cost = est ? ` About $${est.first.toFixed(2)} for the first message, then about $${est.next.toFixed(2)} each.` : "";
      warn.createDiv({
        text: m
          ? `Your profile${m.recent ? ", your latest journal entries" : ""} and your earlier conversations with ${m.name(owner, this.selfEra())} go to Anthropic to be read by ${model} with every message — and your own messages, journal and notes when your profile is made. Ariadne otherwise never sends correspondence or journal entries to a cloud model.${cost}`
          : p
            ? `Your correspondence with ${p.name}, and what your journal says of them, go to Anthropic to be read by ${model} — when the persona is made, and with every message. Ariadne otherwise never sends correspondence or journal entries to a cloud model.${cost}`
            : `Your description is sent to Anthropic with every message, to be answered by ${model}.`,
      });
      const label = warn.createEl("label", { cls: "ariadne-persona-consent" });
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = this.consent;
      label.appendText(" Send them to Anthropic for this conversation");
      box.addEventListener("change", () => {
        this.consent = box.checked;
        this.render();
      });
    } else if (choice && shown) {
      note(`Answered by ${choice.label}; nothing leaves your machines.`);
    }
    this.sendEl.disabled = !canSend();
  }

  private send(): Promise<void> {
    const text = this.inputEl.value.trim();
    return text ? this.exchange(text) : Promise.resolve();
  }

  /** One message and its reply — or, with no message, the persona begins. */
  private async exchange(text: string | undefined): Promise<void> {
    const choice = this.chosen();
    if (this.busy || this.making || !choice || !this.ready()) return;
    if (choice.cloud && !this.consent) {
      new Notice("Tick “Send them to Anthropic” first, or pick a model on your machines.");
      return;
    }
    const m = this.made();
    const gen = this.generation;
    this.busy = true;
    this.sendEl.disabled = true;
    if (text) this.inputEl.value = "";
    this.render();
    try {
      // The persona is put together on the first message, from its note: not shown, only talked with.
      if (!this.persona) {
        const free = this.personEl.value === FREE;
        if (m) {
          const made = await this.deps.premade(m.id, this.selfEra(), choice.route);
          const now = new Date().toISOString();
          this.persona = made;
          this.record = { id: m.id, name: made.name, owner: this.deps.owner.get().trim(), era: this.selfEra(), model: choice.label, started: now, updated: now, turns: [], since: made.since };
        } else this.persona = await this.deps.persona({ person: this.person(), description: free ? this.describeEl.value.trim() : undefined, era: this.era(), route: choice.route });
        if (gen !== this.generation) return;
      }
      const persona = this.persona;
      // With no message, the persona begins: an unseen first turn says so.
      const said = text ?? (persona as Partial<PremadePersona>).opener ?? "(You begin.)";
      this.turns.push({ role: "user", content: said });
      if (text) this.listEl.createDiv({ cls: "ariadne-chat-msg ariadne-chat-user", text });
      const waiting = this.listEl.createDiv({ cls: "ariadne-chat-working", text: `${persona.name} is writing…` });
      this.listEl.scrollTop = this.listEl.scrollHeight;
      try {
        const reply = await this.deps.talk(choice.route, persona, this.turns);
        if (gen !== this.generation) return;
        this.turns.push({ role: "assistant", content: reply.text });
        const el = this.listEl.createDiv({ cls: "ariadne-chat-msg ariadne-chat-reply ariadne-persona-reply" });
        el.createDiv({ cls: "ariadne-persona-who", text: `${persona.name} (simulated)${reply.costUsd ? ` · $${reply.costUsd.toFixed(3)}` : ""}` });
        el.createDiv({ cls: "ariadne-persona-text", text: reply.text });
        if (this.record) {
          if (text) this.record.turns.push({ role: "user", content: text });
          this.record.turns.push({ role: "assistant", content: reply.text });
          this.record.updated = new Date().toISOString();
          await this.keep();
          this.maybeAskCloseness();
        }
      } catch (err) {
        this.turns.pop();
        if (text) this.inputEl.value = text;
        this.listEl.createDiv({ cls: "ariadne-chat-msg ariadne-chat-reply ariadne-chat-failed", text: `No reply: ${err instanceof Error ? err.message : "error"}` });
      } finally {
        waiting.remove();
      }
    } catch (err) {
      if (text) this.inputEl.value = text;
      this.listEl.createDiv({ cls: "ariadne-chat-msg ariadne-chat-reply ariadne-chat-failed", text: `Could not start: ${err instanceof Error ? err.message : "error"}` });
    } finally {
      this.busy = false;
      this.listEl.scrollTop = this.listEl.scrollHeight;
      if (gen === this.generation) this.render();
    }
  }

  /** The conversation is kept as a note after every reply, so that the persona remembers it. */
  private async keep(): Promise<void> {
    if (!this.record) return;
    try {
      await this.deps.saveConversation(this.record);
    } catch (err) {
      new Notice(`This conversation could not be kept: ${err instanceof Error ? err.message : "error"}`);
    }
  }

  /**
   * Once, after a few messages: how close the owner feels — the Inclusion of
   * Other in Self scale, seven pairs of circles from apart to almost one —
   * kept with the conversation.
   */
  private maybeAskCloseness(): void {
    const r = this.record;
    if (!r || r.closeness || this.askedCloseness) return;
    const mine = r.turns.filter((t) => t.role === "user").length;
    if (mine < ASK_CLOSENESS_AFTER) return;
    this.askedCloseness = true;
    const box = this.listEl.createDiv({ cls: "ariadne-persona-ios" });
    box.createDiv({ cls: "ariadne-persona-ios-q", text: `How close do you feel to ${r.name} right now? Pick the pair of circles — you, and them.` });
    const row = box.createDiv({ cls: "ariadne-persona-ios-row" });
    for (let n = 1; n <= CLOSENESS_STEPS; n++) {
      const b = row.createEl("button", { cls: "ariadne-persona-ios-pick", attr: { title: `${n} of ${CLOSENESS_STEPS}`, "aria-label": `${n} of ${CLOSENESS_STEPS}` } });
      const d = 22 - ((n - 1) * 20) / (CLOSENESS_STEPS - 1);
      const svg = b.createSvg("svg", { attr: { width: "46", height: "24", viewBox: "0 0 46 24" } });
      svg.createSvg("circle", { attr: { cx: String(23 - d / 2), cy: "12", r: "9", fill: "none", stroke: "currentColor", "stroke-width": "1.5" } });
      svg.createSvg("circle", { attr: { cx: String(23 + d / 2), cy: "12", r: "9", fill: "none", stroke: "currentColor", "stroke-width": "1.5" } });
      b.addEventListener("click", () => {
        r.closeness = n;
        r.closenessTurn = mine;
        void this.keep();
        box.replaceChildren();
        box.createDiv({ cls: "ariadne-chat-note", text: `Kept with this conversation: ${n} of ${CLOSENESS_STEPS}.` });
      });
    }
    const skip = box.createEl("button", { cls: "ariadne-persona-inline", text: "Not now" });
    skip.addEventListener("click", () => box.remove());
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}

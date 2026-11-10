// Redirect notes are chosen from this list. A query value that is not a key is ignored.

export const HOME_NOTES = {
  unusable: "Type a Philadelphia address or a 9-digit OPA account.",
  limit: "Three dossiers a day can be drawn from here. That number has been reached.",
  atlas: "The city atlas did not answer. Try again, or look the address up by hand.",
} as const;

export const DOSSIER_NOTES = {
  started: "The remaining sheets are being read.",
  already: "Those sheets are already being read, or have been read.",
  limit: "The daily limit for reading the remaining sheets from here has been reached.",
  budget: "Public Agent reads are paused while spend is over the budget. The free sheets are complete.",
  no_slot: "No free watch slot is left.",
  watch_limit: "One address a day can be watched from here. That number has been reached.",
  watched: "This address is now watched.",
  failed: "That request could not be completed. Try again.",
} as const;

export type HomeNote = keyof typeof HOME_NOTES;
export type DossierNote = keyof typeof DOSSIER_NOTES;

export function homeNote(code: string | undefined): string | null {
  if (code && Object.hasOwn(HOME_NOTES, code)) return HOME_NOTES[code as HomeNote];
  return null;
}

export function dossierNoteCode(code: string | undefined): DossierNote | null {
  if (code && Object.hasOwn(DOSSIER_NOTES, code)) return code as DossierNote;
  return null;
}

export { gapReason } from "../dossier/reasons";

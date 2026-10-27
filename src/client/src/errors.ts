export interface LocalError {
  id: number;
  message: string;
}

type Listener = (e: LocalError) => void;
const listeners = new Set<Listener>();
let seq = 0;

/** Surface an error to the user (rendered as a toast by Notifications). */
export const showError = (message: string): void => {
  const e: LocalError = { id: ++seq, message };
  listeners.forEach((l) => l(e));
};

export const onError = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

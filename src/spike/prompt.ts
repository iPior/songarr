/**
 * Interactive selection helpers.
 *
 * The MVP will replace these with a React UI, but the *shape* is the point: the pipeline
 * asks a `Prompter` to make the two ambiguous decisions (which release, which file), so the
 * automated tests can substitute a scripted answer and drive the whole flow headlessly.
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface Choice<T> {
  value: T;
  /** One line, already column-formatted by the caller. */
  label: string;
  /** Shown indented beneath the label; used for match reasons. */
  detail?: string;
  /** Displayed but not selectable, e.g. a non-audio file (PRD 9.4). */
  disabled?: boolean;
  /** Marks the recommended entry. */
  recommended?: boolean;
}

export interface Prompter {
  select<T>(question: string, choices: readonly Choice<T>[]): Promise<T>;
  confirm(question: string, defaultAnswer?: boolean): Promise<boolean>;
  close(): Promise<void>;
}

export class PromptAbortedError extends Error {
  readonly code = 'PROMPT_ABORTED';
  constructor(message = 'Aborted at the prompt') {
    super(message);
    this.name = 'PromptAbortedError';
  }
}

/** A terminal prompter. Writes to stdout so logs (stderr) can be redirected away. */
export function createTerminalPrompter(): Prompter {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  return {
    async select<T>(question: string, choices: readonly Choice<T>[]): Promise<T> {
      const selectable = choices.filter((choice) => !choice.disabled);
      if (selectable.length === 0) {
        throw new PromptAbortedError('There is nothing selectable to choose from');
      }

      stdout.write(`\n${question}\n\n`);
      choices.forEach((choice, index) => {
        const number = choice.disabled ? '  -' : String(index + 1).padStart(3);
        const marker = choice.recommended ? ' *' : '  ';
        stdout.write(`${number}${marker} ${choice.label}\n`);
        if (choice.detail) stdout.write(`      ${choice.detail}\n`);
      });
      if (choices.some((choice) => choice.recommended)) {
        stdout.write('\n  * = recommended\n');
      }

      const defaultIndex = choices.findIndex((choice) => choice.recommended && !choice.disabled);
      const defaultLabel = defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : '';

      for (;;) {
        const answer = (await rl.question(`\nSelect a number${defaultLabel} (q to abort): `)).trim();

        if (answer.toLowerCase() === 'q') throw new PromptAbortedError();
        if (answer === '' && defaultIndex >= 0) return choices[defaultIndex]!.value;

        const index = Number(answer) - 1;
        const choice = choices[index];
        if (!choice) {
          stdout.write(`  Enter a number between 1 and ${choices.length}.\n`);
          continue;
        }
        if (choice.disabled) {
          stdout.write('  That entry is not selectable.\n');
          continue;
        }
        return choice.value;
      }
    },

    async confirm(question: string, defaultAnswer = false): Promise<boolean> {
      const hint = defaultAnswer ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
      if (answer === '') return defaultAnswer;
      return answer === 'y' || answer === 'yes';
    },

    async close(): Promise<void> {
      rl.close();
    },
  };
}

/**
 * A prompter that answers from a script. Used by the end-to-end test to drive the pipeline
 * without a terminal; each answer is a 1-based index or a predicate over the choices.
 */
export function createScriptedPrompter(script: {
  selections: readonly (number | ((choices: readonly Choice<unknown>[]) => number))[];
  confirmations?: readonly boolean[];
}): Prompter {
  let selectionIndex = 0;
  let confirmationIndex = 0;

  return {
    async select<T>(question: string, choices: readonly Choice<T>[]): Promise<T> {
      const entry = script.selections[selectionIndex];
      selectionIndex += 1;
      if (entry === undefined) {
        throw new PromptAbortedError(`Scripted prompter ran out of answers at: ${question}`);
      }
      const index = typeof entry === 'function' ? entry(choices as readonly Choice<unknown>[]) : entry - 1;
      const choice = choices[index];
      if (!choice || choice.disabled) {
        throw new PromptAbortedError(`Scripted selection ${index + 1} is not selectable for: ${question}`);
      }
      return choice.value;
    },

    async confirm(_question: string, defaultAnswer = false): Promise<boolean> {
      const answer = script.confirmations?.[confirmationIndex];
      confirmationIndex += 1;
      return answer ?? defaultAnswer;
    },

    async close(): Promise<void> {
      // Nothing to release.
    },
  };
}

/** A provider session cannot be resumed; no new turn or broker action has started. */
export class ManagedResumeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedResumeUnavailableError";
  }
}

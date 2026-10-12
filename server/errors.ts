export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function safeError(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : 'Operation failed. Check integration configuration and connectivity; no credentials were logged.';
}

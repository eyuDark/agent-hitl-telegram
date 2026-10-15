export class HitlApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.name = "HitlApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class HitlTimeoutError extends Error {
  readonly shortId: string;

  constructor(shortId: string, message: string) {
    super(message);
    this.name = "HitlTimeoutError";
    this.shortId = shortId;
  }
}

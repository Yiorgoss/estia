import { ChatId, ListingId } from "@/db/schema/brands";
import { Schema } from "effect";

export class ChatNotFoundError extends Schema.TaggedError<ChatNotFoundError>()(
  "ChatNotFoundError",
  { id: ChatId },
  { httpApiStatus: 404 },
) {}

export class ChatForbiddenError extends Schema.TaggedError<ChatForbiddenError>()(
  "ChatForbiddenError",
  { id: ChatId },
  { httpApiStatus: 403 },
) {}

export class ChatSelfNotAllowedError extends Schema.TaggedError<ChatSelfNotAllowedError>()(
  "ChatSelfNotAllowedError",
  { listingId: ListingId },
  { httpApiStatus: 400 },
) {}

export class ChatValidationError extends Schema.TaggedError<ChatValidationError>()(
  "ChatValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class ChatConflictError extends Schema.TaggedError<ChatConflictError>()(
  "ChatConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class ChatRateLimitError extends Schema.TaggedError<ChatRateLimitError>()(
  "ChatRateLimitError",
  {
    message: Schema.String,
    retryAfterMs: Schema.Int,
  },
  { httpApiStatus: 429 },
) {}

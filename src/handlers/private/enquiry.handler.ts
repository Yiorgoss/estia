import { PrivateApi } from "@/api/private";
import { callerId } from "@/handlers/private/caller";
import { EnquiryService } from "@/services/enquiry.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";

/*
 * The authenticated enquiry endpoints. The caller is always the sender on a
 * send, and the account whose sent or received list is read; no request carries
 * an account id. The service owns the visibility, ownership, and rate rules, so
 * the handlers only wire the calls.
 */
export const EnquiryHandler = HttpApiBuilder.group(PrivateApi, "enquiry-group", (handlers) =>
  handlers
    .handle("send", ({ params, payload }) =>
      Effect.gen(function* () {
        const senderId = yield* callerId;
        const service = yield* EnquiryService;
        return yield* service.send(senderId, params.id, payload);
      }),
    )
    .handle("sent", ({ query }) =>
      Effect.gen(function* () {
        const senderId = yield* callerId;
        const service = yield* EnquiryService;
        return yield* service.listSent(senderId, query.cursor);
      }),
    )
    .handle("received", ({ query }) =>
      Effect.gen(function* () {
        const ownerId = yield* callerId;
        const service = yield* EnquiryService;
        return yield* service.listReceived(ownerId, query.cursor);
      }),
    ),
);

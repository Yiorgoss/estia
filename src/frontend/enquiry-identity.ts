import type { SenderIdentity } from "@/services/enquiry.service";
import { escapeHtml } from "@/utils";

/*
 * What the contact path will show the lister, rendered from the same resolver
 * the send uses. A page that previewed an identity the send refused, or one
 * resolved by its own copy of the rule, would tell the sender something the
 * lister never reads, so both the enquiry form and the profile form render this
 * one sentence.
 */
export const senderIdentityPreview = (identity: SenderIdentity): string => {
  if (identity.contact === null) {
    return "An enquiry cannot be sent until you add a contact detail to your profile.";
  }
  if (identity.name === null) {
    return "An enquiry cannot be sent until you add a name to your profile.";
  }
  return `The lister sees this on an enquiry you send: ${escapeHtml(identity.name)} - ${escapeHtml(identity.contact)}.`;
};

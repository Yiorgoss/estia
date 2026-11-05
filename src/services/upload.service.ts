import { UserId } from "@/brands";
import { R2UploadError, StorageRepository } from "@/repos/storage.repo";
import { UserRepository } from "@/repos/user.repo";
import { Config, Context, Effect, Layer, Stream } from "effect";
import { ConfigError } from "effect/Config";
import { Multipart } from "effect/http";

export interface UploadService {
  uploadAvatar(
    userId: typeof UserId.Type,
    image: Multipart.File,
  ): Effect.Effect<R2Object, R2UploadError | ConfigError>;
}

export const UploadService = Context.Service<UploadService>("UploadService");

export const UploadServiceLive = () =>
  Layer.effect(
    UploadService,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const userRepo = yield* UserRepository;
      return {
        uploadAvatar: (userId, image) =>
          Effect.gen(function* () {
            const ext = image.contentType.split("/")[1];
            const key = `${userId}/profile/avatar.${ext}`;
            const content = Stream.toReadableStream(image.content);
            const r2obj = yield* storage.put(key, content);

            //insert into user
            const base = yield* Config.String("DOMAIN");
            const imgUrl = `${base}/${key}?v=${r2obj.etag}`;
            userRepo.updateAvatar(userId, imgUrl);

            return r2obj;
          }),
      };
    }),
  );

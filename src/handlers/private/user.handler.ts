import { PrivateApi } from "@/api/private";
import { JWTSchema } from "@/db/schema/brands";
import { ListerRepository } from "@/repo/lister.repo";
import { SeekerRepository } from "@/repo/seeker.repo";
import { UnauthorizedError } from "@/services/auth.service";
import { JWTService } from "@/services/jwt.service";
import { InternalError, UserService } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect, Option, Schema } from "effect";

export const UserHandler = HttpApiBuilder.group(PrivateApi, "user-group", (handlers) =>
  handlers
    .handle("me", ({ request }) =>
      Effect.gen(function* () {
        const jwtService = yield* JWTService;
        const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
          request.cookies["access_token"],
        );
        const userJWT = yield* jwtService.verify(accessToken);
        const user = yield* jwtService.extractUser(userJWT);

        const listerRepo = yield* ListerRepository;
        const seekerRepo = yield* SeekerRepository;
        let userProfile;
        if (user.role == "lister") {
          userProfile = yield* listerRepo.findByUserId(user.id).pipe(
            Effect.filterOrFail(Option.isSome, () => new InternalError()),
            Effect.map((x) => x.value),
          );
        } else {
          userProfile = yield* seekerRepo.findByUserId(user.id).pipe(
            Effect.filterOrFail(Option.isSome, () => new InternalError()),
            Effect.map((x) => x.value),
          );
        }
        return { user, userProfile };
      }).pipe(
        Effect.catchTags({
          ExpiredJWTError: () => Effect.fail(new UnauthorizedError()),
          SchemaError: () => Effect.fail(new InternalError()),
          InvalidJWTError: () => Effect.fail(new InternalError()),
          SqlError: () => Effect.fail(new InternalError()),
        }),
      ),
    )
    .handle("change-role", (req) =>
      Effect.gen(function* () {
        const jwtService = yield* JWTService;
        const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(
          req.request.cookies["access_token"],
        );
        const userJWT = yield* jwtService.verify(accessToken);
        const user = yield* jwtService.extractUser(userJWT);

        const newRole = user.role == "lister" ? "seeker" : "lister";

        const userService = yield* UserService;

        const newProfile = yield* userService.switchRoles(user.id, newRole);
        return { newProfile };
      }).pipe(
        Effect.catchTags({
          ExpiredJWTError: () => Effect.fail(new UnauthorizedError()),
          SchemaError: () => Effect.fail(new InternalError()),
          InvalidJWTError: () => Effect.fail(new InternalError()),
          // SqlError: (e) => Effect.fail(new InternalError()),
        }),
      ),
    ),
);

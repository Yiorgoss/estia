import { Schema } from "effect"

/*
* Vite seems to be loading the definition or some shit but not the value? IDK
* Basically shits getting loaded before each other
* Maybe cyclical deps, maybe I could give a fuck. Stick all brandedtypes in here and well be all right
*/
export const JWTSchema = Schema.String.pipe(Schema.brand("JWT"))

export const UserPasswordHash = Schema.String.pipe(Schema.brand("UserPasswordHash"))
export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export const UserRoles = Schema.Literals(["admin", "seeker", "lister", "user"]) //user is unassigned

export const RefreshTokenValue = Schema.String.pipe(Schema.brand("RefreshTokenValue"))
export const RefreshTokenHash = Schema.String.pipe(Schema.brand("RefreshTokenHash"))
export const RefreshTokenId = Schema.String.pipe(Schema.brand("RefreshTokenId"))

export const OwnershipEnum = Schema.Literals(["owner", "leaseholder"])
export const ListerId = Schema.Number.pipe(Schema.brand("ListerId"))

export const RoomId = Schema.Number.pipe(Schema.brand("RoomId"))

export const SeekerId = Schema.Number.pipe(Schema.brand("SeekerID"))
export const GenderEnum = Schema.Literals(["male", "female", "NB"])

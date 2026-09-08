-- A lien search names an owner, so it is person-keyed even though the query
-- goes in by parcel number. It needs its own data category rather than
-- borrowing one: the assessor record, the AVM and the flood determination for
-- the same parcel need nobody's permission, and a category that covered both
-- would blur the one line the address/person split exists to draw.
--
-- ADD VALUE cannot run inside a transaction block that also USES the value, but
-- this migration only adds it, which Postgres 12+ permits.

-- AlterEnum
ALTER TYPE "DataCategory" ADD VALUE 'PUBLIC_RECORD_LIENS';

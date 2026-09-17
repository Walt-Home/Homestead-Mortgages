-- A sample household has two sign-ins now: the applicant's, which owns the
-- file, and the co-borrower's, which owns nothing and is listed under the
-- story that does. The co-borrower's key is the story's key with a suffix
-- after a colon, so the listing can find the story a second row belongs to
-- from the key alone. The colon was refused by the old shape, which is what
-- makes it safe as a separator: no bare key can contain one.
ALTER TABLE "users" DROP CONSTRAINT "users_persona_key_shape";
ALTER TABLE "users" ADD CONSTRAINT "users_persona_key_shape"
  CHECK (persona_key IS NULL OR persona_key ~ '^[a-z][a-z0-9_]{1,40}(:[a-z][a-z0-9_]{1,20})?$');

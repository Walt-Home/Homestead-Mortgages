-- A staff member is invited by address, not by domain.
--
-- The servicing app owns the console's staff list and keeps each address
-- hashed and encrypted; its console API answers a masked copy and nothing
-- more. Two things on this host need the address itself. The staff door's
-- sign-in code: the servicing app mints and echoes a code for ANY address
-- asked, known or not, so a proxy that mailed the code to whoever asked
-- would be an open relay, and until 6 October 2026 the gate was "one of our
-- own domains". Joe wants staff on any address, so the gate becomes "an
-- address an admin invited through this console and has not removed, or one
-- of ours", and this table is that list. And sending an invitation again:
-- the servicing app re-invites an address it holds as invited, but cannot
-- be asked for the address, so the console could not do it with one click.
--
-- The staff id is the servicing app's, a string it answered; the two
-- databases are not joined, by design. A removal is a mark, like a
-- servicer's member's: the servicing app disables, never deletes, and some
-- thirty of its tables name a staff row for the record of what they did.
CREATE TABLE "console_staff_invitations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "staff_user_id" TEXT NOT NULL,
    "name" TEXT,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mailed_at" TIMESTAMP(3),
    "mail_outcome" TEXT,
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "console_staff_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "console_staff_invitations_email_key" ON "console_staff_invitations"("email");

CREATE INDEX "console_staff_invitations_staff_user" ON "console_staff_invitations"("staff_user_id");

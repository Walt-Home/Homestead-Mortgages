-- The bank comes before the questions (12 October 2026).
--
-- The stage is "the step reached". Under the old order DECLARATIONS meant
-- "credit done, the questions next"; under the new one that file has reached
-- the bank. A file at BANK already means "the bank next" and keeps its label:
-- whether its questions are answered is read off du_declarations when the
-- bank route decides where to hand it afterwards. No enum change: the set of
-- stages is the same, only the order the API walks them in.
UPDATE "loan_files" SET "stage" = 'BANK' WHERE "stage" = 'DECLARATIONS';

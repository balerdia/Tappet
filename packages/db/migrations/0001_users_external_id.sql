PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`email` text,
	`name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
-- Hand-edited: existing users had no external id. The old seeded dev user maps to the dev sign-in.
INSERT INTO `__new_users`("id", "external_id", "email", "name", "created_at") SELECT "id", CASE WHEN "id" = 'user_dev' THEN 'dev' ELSE 'legacy:' || "id" END, "email", "name", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_id_unique` ON `users` (`external_id`);
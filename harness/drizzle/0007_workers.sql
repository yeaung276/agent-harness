CREATE TABLE "workers" (
	"hostname" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "places" ADD CONSTRAINT "places_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_abbreviation_unique" UNIQUE("abbreviation");--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_abbreviation_unique" UNIQUE("abbreviation");
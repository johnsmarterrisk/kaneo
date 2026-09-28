import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NotificationPreferencesSettings } from "@/components/account/notification-preferences-settings";
import PageTitle from "@/components/page-title";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/account/notifications",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();

  return (
    <>
      <PageTitle title={t("settings:notificationsPage.pageTitle")} />
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="space-y-2">
          {/* text-card-foreground: this heading sits on the settings frame's white
              bg-card panel (settings.tsx), not the app's navy ground — same GUI-4
              pattern as general.tsx and information.tsx. */}
          <h1 className="text-2xl font-semibold text-card-foreground">
            {t("settings:notificationsPage.title")}
          </h1>
          <p className="text-muted-foreground">
            {t("settings:notificationsPage.subtitle")}
          </p>
        </div>

        <NotificationPreferencesSettings />
      </div>
    </>
  );
}

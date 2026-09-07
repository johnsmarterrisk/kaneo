import { useEffect } from "react";
import { useTranslation } from "react-i18next";

type PageTitleProps = {
  title: string;
  suffix?: string;
  hideAppName?: boolean;
};

export default function PageTitle({
  title,
  suffix,
  hideAppName = false,
}: PageTitleProps) {
  const { t } = useTranslation();
  // The product name is branding, so it is read from `common:appName` rather than
  // hard-coded here — that key is the single place the fork renames the app.
  const appName = suffix ?? t("common:appName");

  useEffect(() => {
    const formattedTitle = hideAppName
      ? title
      : appName
        ? `${title} · ${appName}`
        : title;
    document.title = formattedTitle;
  }, [title, appName, hideAppName]);

  return null;
}

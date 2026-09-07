import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import useProjectStore from "@/store/project";

type LogoProps = {
  className?: string;
};

export function Logo({ className = "" }: LogoProps) {
  const { setProject } = useProjectStore();
  const { t } = useTranslation();
  // Alt text is the product name, so it follows the same branding key as the title.
  const appName = t("common:appName");

  return (
    <Link
      onClick={() => {
        setProject(undefined);
      }}
      to="/dashboard"
      className={`w-auto ${className}`}
    >
      <img
        src="/logo-dark.svg"
        alt={appName}
        className="h-6 w-auto dark:hidden"
      />
      <img
        src="/logo-light.svg"
        alt={appName}
        className="hidden h-6 w-auto dark:block"
      />
    </Link>
  );
}

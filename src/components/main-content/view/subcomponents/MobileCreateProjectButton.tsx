import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type MobileCreateProjectButtonProps = {
  onFallbackOpenMenu: () => void;
  compact?: boolean;
};

export default function MobileCreateProjectButton({
  onFallbackOpenMenu,
  compact = false,
}: MobileCreateProjectButtonProps) {
  const { t } = useTranslation();

  const handleOpenLauncher = () => {
    if (window.openProjectLauncher) {
      window.openProjectLauncher();
      return;
    }

    onFallbackOpenMenu();
  };

  const buttonClasses = compact
    ? 'p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60'
    : 'p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 touch-manipulation active:scale-95 flex-shrink-0';

  return (
    <button
      type="button"
      data-testid="mobile-open-project-launcher"
      onClick={handleOpenLauncher}
      className={buttonClasses}
      aria-label={t('tooltips.createProject')}
      title={t('tooltips.createProject')}
    >
      <Plus className="h-5 w-5" />
    </button>
  );
}

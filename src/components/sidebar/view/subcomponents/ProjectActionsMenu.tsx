import { useState, useRef, useEffect } from 'react';
import { Edit3, MoreVertical, Star, Trash2 } from 'lucide-react';
import { cn } from '../../../../lib/utils';

type ProjectActionsMenuProps = {
  isStarred: boolean;
  onToggleStar: (e: React.MouseEvent) => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  t: any;
};

export default function ProjectActionsMenu({
  isStarred,
  onToggleStar,
  onEdit,
  onDelete,
  t,
}: ProjectActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isOpen &&
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleScroll = () => {
      setIsOpen(false);
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Also close on scroll to prevent detached menus
      document.addEventListener('scroll', handleScroll, true);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuHeight = 120;
      const menuWidth = 144;
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY;
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : Number.POSITIVE_INFINITY;
      const margin = 8;

      let top = rect.bottom + 4;
      if (top + menuHeight > viewportHeight) {
        top = rect.top - menuHeight - 4;
      }

      let left = rect.left;
      if (left + menuWidth + margin > viewportWidth) {
        left = Math.max(margin, rect.right - menuWidth);
      }

      setMenuPosition({
        top,
        left,
      });
    }
    setIsOpen(!isOpen);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors',
          isOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100',
          isStarred && !isOpen && 'opacity-100 text-yellow-500'
        )}
        onClick={handleToggle}
        title={t('actions.more', { defaultValue: 'More actions' })}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: menuPosition.top,
            left: menuPosition.left,
            zIndex: 9999,
          }}
          className="w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95"
        >
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={(e) => {
              onToggleStar(e);
              setIsOpen(false);
            }}
          >
            <Star className={cn('h-3.5 w-3.5', isStarred && 'fill-yellow-500 text-yellow-500')} />
            <span>{isStarred ? t('tooltips.removeFromFavorites', { defaultValue: 'Unstar' }) : t('tooltips.addToFavorites', { defaultValue: 'Star' })}</span>
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={(e) => {
              onEdit(e);
              setIsOpen(false);
            }}
          >
            <Edit3 className="h-3.5 w-3.5" />
            <span>{t('tooltips.renameProject', { defaultValue: 'Rename' })}</span>
          </button>
          <div className="my-1 h-px bg-muted" />
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
            onClick={(e) => {
              onDelete(e);
              setIsOpen(false);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t('tooltips.deleteProject', { defaultValue: 'Delete' })}</span>
          </button>
        </div>
      )}
    </>
  );
}

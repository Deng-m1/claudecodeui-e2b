import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../../lib/utils';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../../../hooks/useSidebarWidth';

type SidebarResizeHandleProps = {
  width: number;
  onChange: (nextWidth: number) => void;
};

export default function SidebarResizeHandle({ width, onChange }: SidebarResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);

    const startX = event.clientX;
    const startWidth = widthRef.current;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = startWidth + delta;
      const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, nextWidth));
      onChange(clamped);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [onChange]);

  const handleDoubleClick = useCallback(() => {
    onChange(288);
  }, [onChange]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-testid="sidebar-resize-handle"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className={cn(
        'group hidden md:flex absolute right-0 top-0 z-30 h-full w-1.5 cursor-col-resize items-center justify-center',
        isDragging && 'bg-primary/20',
      )}
      style={{ transform: 'translateX(50%)' }}
      title="Drag to resize · Double-click to reset"
    >
      <div
        className={cn(
          'h-full w-px bg-border/0 transition-colors',
          'group-hover:bg-primary/40',
          isDragging && 'bg-primary/70',
        )}
      />
    </div>
  );
}

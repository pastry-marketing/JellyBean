import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();

  const toggleTheme = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  };

  return (
    <button
      onClick={toggleTheme}
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-surface hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/35 focus:ring-offset-0",
        className,
      )}
    >
      {theme === "light" ? (
        <>
          <Moon className="h-4 w-4" />
          <span>Dark Mode</span>
        </>
      ) : (
        <>
          <Sun className="h-4 w-4" />
          <span>Light Mode</span>
        </>
      )}
    </button>
  );
}

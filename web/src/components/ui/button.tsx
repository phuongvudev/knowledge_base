import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50 cursor-pointer shadow-sm",
  {
    variants: {
      variant: {
        default: "bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-500/20",
        destructive: "bg-red-600 text-white hover:bg-red-500",
        outline: "border border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white",
        secondary: "bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white",
        ghost: "hover:bg-slate-800 text-slate-300 hover:text-white shadow-none",
        success: "bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/30",
        warning: "bg-amber-600/20 text-amber-300 border border-amber-500/30 hover:bg-amber-600/30",
      },
      size: {
        default: "h-8 px-3.5 py-1.5",
        sm: "h-7 rounded-md px-2.5 text-[11px]",
        lg: "h-9 rounded-lg px-4 text-sm",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

/** shadcn 风格基础按钮,变体直接映射 DESIGN.md components token(.btn 系列样式) */
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva('btn', {
  variants: {
    variant: {
      secondary: '',
      primary: 'btn-primary',
      danger: 'btn-danger',
      quiet: 'btn-quiet',
    },
    size: {
      default: '',
      sm: 'btn-sm',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'default' },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

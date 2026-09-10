import {
  createContext,
  useContext,
  useId,
  forwardRef,
  type ReactNode,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
} from 'react';

export interface FormControlContextValue {
  id: string;
  inputId: string;
  labelId: string;
  errorId: string;
  descriptionId: string;
  isInvalid: boolean;
  isRequired: boolean;
  isDisabled: boolean;
  isReadOnly: boolean;
  error?: ReactNode;
  describedBy?: string;
  getInputProps: <T extends Record<string, any>>(props?: T) => T & {
    id: string;
    'aria-invalid'?: true;
    'aria-required'?: true;
    'aria-describedby'?: string;
    disabled?: boolean;
    readOnly?: boolean;
  };
  getLabelProps: <T extends Record<string, any>>(props?: T) => T & {
    id: string;
    htmlFor: string;
  };
  getErrorMessageProps: <T extends Record<string, any>>(props?: T) => T & {
    id: string;
    role: 'alert';
    'aria-live': 'polite';
  };
  getHelperTextProps: <T extends Record<string, any>>(props?: T) => T & {
    id: string;
  };
}

export const FormControlContext = createContext<FormControlContextValue | null>(null);
export const FieldContext = FormControlContext;

export interface UseFormControlOptions {
  id?: string;
  isInvalid?: boolean;
  isRequired?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  describedBy?: string;
}

export function useFormControl(options: UseFormControlOptions = {}): FormControlContextValue {
  const context = useContext(FormControlContext);
  const fallbackId = useId();

  if (context && Object.keys(options).length === 0) {
    return context;
  }

  const baseId = options.id ?? context?.id ?? fallbackId;
  const inputId = `${baseId}-input`;
  const labelId = `${baseId}-label`;
  const errorId = `${baseId}-error`;
  const descriptionId = `${baseId}-desc`;

  const isInvalid = Boolean(
    options.isInvalid ??
      (options.error != null && options.error !== false) ??
      context?.isInvalid,
  );
  const isRequired = Boolean(options.isRequired ?? context?.isRequired);
  const isDisabled = Boolean(options.isDisabled ?? context?.isDisabled);
  const isReadOnly = Boolean(options.isReadOnly ?? context?.isReadOnly);
  const error = options.error ?? context?.error;

  const activeDescribedBy = [
    isInvalid ? errorId : null,
    options.hint != null ? descriptionId : null,
    options.describedBy ?? context?.describedBy,
  ]
    .filter(Boolean)
    .join(' ') || undefined;

  return {
    id: baseId,
    inputId,
    labelId,
    errorId,
    descriptionId,
    isInvalid,
    isRequired,
    isDisabled,
    isReadOnly,
    error,
    describedBy: activeDescribedBy,
    getInputProps: (props = {} as any) => ({
      ...props,
      id: props.id ?? inputId,
      'aria-invalid': isInvalid ? (true as const) : undefined,
      'aria-required': isRequired ? (true as const) : undefined,
      'aria-describedby':
        [props['aria-describedby'], activeDescribedBy].filter(Boolean).join(' ') || undefined,
      disabled: props.disabled ?? (isDisabled || undefined),
      readOnly: props.readOnly ?? (isReadOnly || undefined),
    }),
    getLabelProps: (props = {} as any) => ({
      ...props,
      id: props.id ?? labelId,
      htmlFor: props.htmlFor ?? inputId,
    }),
    getErrorMessageProps: (props = {} as any) => ({
      ...props,
      id: props.id ?? errorId,
      role: 'alert' as const,
      'aria-live': 'polite' as const,
    }),
    getHelperTextProps: (props = {} as any) => ({
      ...props,
      id: props.id ?? descriptionId,
    }),
  };
}

export const useFieldContext = useFormControl;

export interface FormControlProps extends HTMLAttributes<HTMLDivElement>, UseFormControlOptions {
  children?: ReactNode;
}

export function FormControlRoot({
  id,
  isInvalid,
  isRequired,
  isDisabled,
  isReadOnly,
  error,
  hint,
  describedBy,
  children,
  className,
  ...rest
}: FormControlProps) {
  const value = useFormControl({
    id,
    isInvalid,
    isRequired,
    isDisabled,
    isReadOnly,
    error,
    hint,
    describedBy,
  });

  return (
    <FormControlContext.Provider value={value}>
      <div
        data-pyric-form-control
        data-pyric-invalid={value.isInvalid ? '' : undefined}
        data-pyric-disabled={value.isDisabled ? '' : undefined}
        data-pyric-readonly={value.isReadOnly ? '' : undefined}
        data-pyric-required={value.isRequired ? '' : undefined}
        className={className}
        {...rest}
      >
        {children}
      </div>
    </FormControlContext.Provider>
  );
}

export interface FormLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

export const FormLabel = forwardRef<HTMLLabelElement, FormLabelProps>(
  ({ children, className, ...props }, ref) => {
    const context = useContext(FormControlContext);
    const { getLabelProps } = useFormControl();
    const labelProps = context ? getLabelProps(props) : props;
    return (
      <label ref={ref} className={className} {...labelProps}>
        {children}
      </label>
    );
  },
);
FormLabel.displayName = 'FormControl.Label';

export interface FormInputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const FormInput = forwardRef<HTMLInputElement, FormInputProps>(
  ({ className, ...props }, ref) => {
    const context = useContext(FormControlContext);
    const { getInputProps } = useFormControl();
    const inputProps = context ? getInputProps(props) : props;
    return <input ref={ref} className={className} {...inputProps} />;
  },
);
FormInput.displayName = 'FormControl.Input';

export interface FormErrorMessageProps extends HTMLAttributes<HTMLParagraphElement> {}

export const FormErrorMessage = forwardRef<HTMLParagraphElement, FormErrorMessageProps>(
  ({ children, className, id, ...props }, ref) => {
    const context = useContext(FormControlContext);
    if (context && !context.isInvalid && !children) return null;
    const resolvedId = id ?? context?.errorId;
    return (
      <p
        ref={ref}
        id={resolvedId}
        role="alert"
        aria-live="polite"
        className={className}
        {...props}
      >
        {children ?? context?.error}
      </p>
    );
  },
);
FormErrorMessage.displayName = 'FormControl.ErrorMessage';

export interface FormHelperTextProps extends HTMLAttributes<HTMLParagraphElement> {}

export const FormHelperText = forwardRef<HTMLParagraphElement, FormHelperTextProps>(
  ({ children, className, id, ...props }, ref) => {
    const context = useContext(FormControlContext);
    const resolvedId = id ?? context?.descriptionId;
    return (
      <p ref={ref} id={resolvedId} className={className} {...props}>
        {children}
      </p>
    );
  },
);
FormHelperText.displayName = 'FormControl.HelperText';

export const FormControl = Object.assign(FormControlRoot, {
  Label: FormLabel,
  Input: FormInput,
  ErrorMessage: FormErrorMessage,
  Error: FormErrorMessage,
  HelperText: FormHelperText,
  Description: FormHelperText,
});

export const Field = FormControl;

// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import {
  FormControl,
  Field,
  useFormControl,
  useFieldContext,
  FormControlContext,
  FieldContext,
} from '../../src/primitives/index.js';

afterEach(() => cleanup());

describe('<FormControl>', () => {
  it('renders container with data-pyric-form-control marker', () => {
    const { container } = render(
      <FormControl id="test-field">
        <FormControl.Label>Email</FormControl.Label>
        <FormControl.Input />
      </FormControl>,
    );

    const root = container.querySelector('[data-pyric-form-control]');
    expect(root).not.toBeNull();

    const label = container.querySelector('label');
    const input = container.querySelector('input');
    expect(label).not.toBeNull();
    expect(input).not.toBeNull();
    expect(label!.getAttribute('for')).toBe(input!.id);
    expect(input!.id).toBe('test-field-input');
  });

  it('links aria-describedby and role="alert" when error is present', () => {
    const { container } = render(
      <FormControl id="user-email" error="Invalid email address">
        <FormControl.Label>Email</FormControl.Label>
        <FormControl.Input />
        <FormControl.Error />
      </FormControl>,
    );

    const input = container.querySelector('input')!;
    const error = container.querySelector('[role="alert"]')!;

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error).not.toBeNull();
    expect(error.textContent).toBe('Invalid email address');
    expect(error.id).toBe('user-email-error');
    expect(input.getAttribute('aria-describedby')).toBe('user-email-error');
  });

  it('omits error element when there is no error and isInvalid is false', () => {
    const { container } = render(
      <FormControl id="valid-field">
        <FormControl.Label>Username</FormControl.Label>
        <FormControl.Input />
        <FormControl.Error />
      </FormControl>,
    );

    const error = container.querySelector('[role="alert"]');
    const input = container.querySelector('input')!;

    expect(error).toBeNull();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('links helper text to aria-describedby', () => {
    const { container } = render(
      <FormControl id="with-hint" hint="Must be at least 8 characters">
        <FormControl.Label>Password</FormControl.Label>
        <FormControl.Input type="password" />
        <FormControl.HelperText>Must be at least 8 characters</FormControl.HelperText>
      </FormControl>,
    );

    const input = container.querySelector('input')!;
    const hint = container.querySelector('#with-hint-desc')!;

    expect(hint).not.toBeNull();
    expect(hint.textContent).toBe('Must be at least 8 characters');
    expect(input.getAttribute('aria-describedby')).toBe('with-hint-desc');
  });

  it('combines error and hint in aria-describedby when both exist', () => {
    const { container } = render(
      <FormControl id="both" error="Password too weak" hint="At least 8 chars">
        <FormControl.Label>Password</FormControl.Label>
        <FormControl.Input type="password" />
        <FormControl.HelperText>At least 8 chars</FormControl.HelperText>
        <FormControl.Error />
      </FormControl>,
    );

    const input = container.querySelector('input')!;
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toContain('both-error');
    expect(describedBy).toContain('both-desc');
  });

  it('surfaces state attributes on container element', () => {
    const { container } = render(
      <FormControl isInvalid isRequired isDisabled isReadOnly>
        <FormControl.Input />
      </FormControl>,
    );

    const root = container.querySelector('[data-pyric-form-control]')!;
    expect(root.hasAttribute('data-pyric-invalid')).toBe(true);
    expect(root.hasAttribute('data-pyric-required')).toBe(true);
    expect(root.hasAttribute('data-pyric-disabled')).toBe(true);
    expect(root.hasAttribute('data-pyric-readonly')).toBe(true);

    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.hasAttribute('disabled')).toBe(true);
    expect(input.hasAttribute('readonly')).toBe(true);
  });

  it('Field is an alias for FormControl', () => {
    expect(Field).toBe(FormControl);
    expect(FieldContext).toBe(FormControlContext);
    expect(useFieldContext).toBe(useFormControl);
  });

  it('useFormControl hook works standalone with prop getters', () => {
    function CustomField() {
      const { getInputProps, getLabelProps, getErrorMessageProps } = useFormControl({
        id: 'standalone',
        error: 'Required field',
      });

      return (
        <div>
          <label {...getLabelProps()}>Standalone Label</label>
          <input {...getInputProps()} />
          <p {...getErrorMessageProps()}>Required field</p>
        </div>
      );
    }

    const { container } = render(<CustomField />);
    const label = container.querySelector('label')!;
    const input = container.querySelector('input')!;
    const error = container.querySelector('[role="alert"]')!;

    expect(label.getAttribute('for')).toBe('standalone-input');
    expect(input.id).toBe('standalone-input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('standalone-error');
    expect(error.id).toBe('standalone-error');
  });
});

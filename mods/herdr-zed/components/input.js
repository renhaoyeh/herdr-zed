import { Input as NativeInput } from 'gpui-base';

// Sera text fields. Keep state in the owning view; callers supply identity,
// accessibility and layout. Explicit sizing/border overrides support compact
// search bars and bordered configuration fields without changing the radius.
export const Input = {
  new(state, t) {
    return NativeInput.new(state).h(36).px(10).rounded(0)
      .border_b(1).border_color(t.input).text_size(13);
  },
};

import { Converter, ReflectionKind } from 'typedoc';

const USER_NAMED_KINDS =
  ReflectionKind.Variable |
  ReflectionKind.Function |
  ReflectionKind.Class |
  ReflectionKind.Interface |
  ReflectionKind.Enum |
  ReflectionKind.TypeAlias |
  ReflectionKind.Property |
  ReflectionKind.Method |
  ReflectionKind.Accessor;

/**
 * TypeDoc treats underscore-prefixed members as public when declarations do.
 * Pyric's public-surface contract does not. Remove those reflections before
 * Markdown and JSON renderers see the project so the generated reference never
 * documents implementation plumbing such as `_internalPath`.
 */
export function load(application) {
  application.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const hidden = Object.values(context.project.reflections).filter(
      (reflection) =>
        reflection !== context.project &&
        reflection.kindOf(USER_NAMED_KINDS) &&
        reflection.name.startsWith('_'),
    );
    for (const reflection of hidden) context.project.removeReflection(reflection);
  });
}

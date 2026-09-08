import type { z } from 'zod';
import type { LocalSandbox, AuthLens } from 'pyric/sandbox';

export interface ActuationContext {
  readonly sandbox: LocalSandbox;
  readonly caller?: AuthLens;
}

export interface TypedToolContract<
  TName extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TParams extends z.ZodObject<any> = z.ZodObject<any>,
  TResult = unknown,
> {
  readonly name: TName;
  readonly description: string;
  readonly transport: 'forwarded' | 'in-process';
  readonly parameters: TParams;
  readonly jsonSchema: Record<string, unknown>;
  /** Pure domain function binding — delegates directly to pyric/actuation. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly execute: (args: any, ctx: ActuationContext) => Promise<TResult> | TResult;
}

export interface TypedResourceContract<
  TUriTemplate extends `pyric://${string}` = `pyric://${string}`,
  TParams extends Record<string, string> = Record<string, string>,
  TResult = unknown,
> {
  readonly uriTemplate: TUriTemplate;
  readonly name: string;
  readonly description: string;
  readonly mimeType: 'application/json';
  /** Pure domain function binding for resource read. */
  readonly read: (uri: URL, params: TParams, ctx: ActuationContext) => Promise<TResult> | TResult;
}

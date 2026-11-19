/**
 * Branded identifier types.
 *
 * Identifiers are plain strings on the wire, but branding stops one kind of id
 * from being passed where another is expected.
 */
declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

/** Supervisor-assigned id of a managed agent session. */
export type SessionId = Branded<string, 'SessionId'>;

/** Id of one blocked question waiting for a human decision. */
export type DecisionId = Branded<string, 'DecisionId'>;

export const asSessionId = (value: string): SessionId => value as SessionId;
export const asDecisionId = (value: string): DecisionId => value as DecisionId;
export const asConversationId = (value: string): ConversationId => value as ConversationId;

/** Id of the main conversation the human talks to (the router session). */
export type ConversationId = Branded<string, 'ConversationId'>;

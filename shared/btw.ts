import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const questionFields = {
  id: z.string(),
  question: z.string(),
};

export const QuestionSchema = z.discriminatedUnion("status", [
  z.object({ ...questionFields, status: z.literal("running") }),
  z.object({
    ...questionFields,
    status: z.literal("complete"),
    answer: z.string(),
  }),
  z.object({
    ...questionFields,
    status: z.literal("error"),
    error: z.string(),
  }),
  z.object({ ...questionFields, status: z.literal("cancelled") }),
]);

export type Question = z.infer<typeof QuestionSchema>;

export const startQuestion = defineRpc({
  name: "btw.start",
  input: z.object({
    agentId: z.string(),
    question: z.string().refine((value) => value.trim().length > 0),
  }),
  output: z.object({ id: z.string() }),
});

export const listQuestions = defineRpc({
  name: "btw.list",
  input: z.object({ agentId: z.string() }),
  output: z.object({ questions: z.array(QuestionSchema) }),
});

export const cancelQuestion = defineRpc({
  name: "btw.cancel",
  input: z.object({ agentId: z.string(), id: z.string() }),
  output: z.object({}),
});

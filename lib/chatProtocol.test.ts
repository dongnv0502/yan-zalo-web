// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { ThreadType } from "zca-js";
import {
  extractMessageIdentity,
  extractQuoteMetadata,
  extractQuotePreview,
  extractUndoTarget,
  hasUnverifiedHistoryUndoShape,
  readProtocolId,
} from "./chatProtocol";

// Use the same parser dependency as the installed SDK's compressed event decoder.
// These inputs exercise decoded shapes; they are not live Zalo captures.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("zca-js"));
const jsonBig: { parse(text: string): unknown } = sdkRequire("json-bigint");

const quoteFields = {
  content: "Tin nhắn gốc\nChưa sửa.",
  msgType: "webchat",
  uidFrom: "950000000000000001",
  msgId: "950000000000000002",
  cliMsgId: "950000000000000003",
  ts: "1700000000000",
  ttl: 0,
};

function message(data: Record<string, unknown>, type: ThreadType = ThreadType.User) {
  return { type, threadId: "thread-1", isSelf: false, data };
}

it("keeps exact SDK numeric and string IDs but refuses already-rounded numbers", () => {
  expect(readProtocolId(jsonBig.parse("950000000000000002"))).toBe("950000000000000002");
  expect(readProtocolId(jsonBig.parse("9500000000000000000000000001"))).toBe("9500000000000000000000000001");
  expect(readProtocolId("000950000000000000002")).toBe("000950000000000000002");
  expect(readProtocolId(123)).toBe("123");
  expect(readProtocolId(JSON.parse("950000000000000002"))).toBeUndefined();
  expect(readProtocolId(jsonBig.parse("950000000000000002.5"))).toBeUndefined();
  expect(readProtocolId({ _isBigNumber: true, e: 17, toFixed: () => "950000000000000002" })).toBeUndefined();
  for (const invalid of [0, "0", "", " ", "123 ", -1, 1.5, Infinity, null, {}]) {
    expect(readProtocolId(invalid)).toBeUndefined();
  }
});

it("extracts a media message identity independently of whether its content can be quoted", () => {
  const data = { ...quoteFields, msgType: "chat.photo", content: { href: "https://example.test/a.jpg" } };
  expect(extractMessageIdentity(message(data, ThreadType.Group))).toEqual({
    globalId: "950000000000000002", cliId: "950000000000000003", senderId: "950000000000000001",
  });
  expect(extractQuoteMetadata(message(data, ThreadType.Group))).toBeUndefined();
  expect(extractMessageIdentity(message({ uidFrom: "sender-1", cliMsgId: "cli-1" }))).toEqual({
    cliId: "cli-1", senderId: "sender-1",
  });
  expect(extractMessageIdentity(message({ ...data, msgId: Number.MAX_SAFE_INTEGER + 1 }))).toBeUndefined();
  expect(extractMessageIdentity(message({ ...data, uidFrom: "0" }))).toBeUndefined();
  expect(extractMessageIdentity({ msgId: 42 })).toBeUndefined();
});

it("keeps only SDK quote fields and does not invent group property metadata", () => {
  const propertyExt = { color: 1, size: 12, type: 2, subType: 0, ext: "{}" };
  expect(extractQuoteMetadata(message({ ...quoteFields, propertyExt: { ...propertyExt, extra: true }, privateField: "secret" }))).toEqual({
    ...quoteFields, propertyExt,
  });
  expect(extractQuoteMetadata(message(quoteFields, ThreadType.Group))).toEqual({ ...quoteFields, propertyExt: undefined });
  expect(extractQuoteMetadata(message({ ...quoteFields, cliMsgId: Number.MAX_SAFE_INTEGER + 1 }))).toBeUndefined();
  expect(extractQuoteMetadata(message({ ...quoteFields, ttl: undefined }))).toBeUndefined();
  expect(extractQuoteMetadata(message({ ...quoteFields, propertyExt: { color: "unknown" } }))).toBeUndefined();
  expect(extractQuoteMetadata(message({ ...quoteFields, msgType: "group.poll" }, ThreadType.Group))).toBeUndefined();
  expect(extractQuoteMetadata(message({ ...quoteFields, content: { msg: quoteFields.content } }))).toBeUndefined();
});

it("keeps only the bounded quote snippet and the exact global jump ID", () => {
  const preview = extractQuotePreview(message({ quote: {
    globalMsgId: jsonBig.parse("950000000000000002"),
    cliMsgId: "950000000000000003",
    msg: "x".repeat(159) + "😀tail",
    fromD: "unverified display field",
    attach: "private upstream data",
  } }));
  expect(preview).toEqual({ targetId: "950000000000000002", text: "x".repeat(159) });
  expect(extractQuotePreview(message({ quote: {
    globalMsgId: Number.MAX_SAFE_INTEGER + 1,
    cliMsgId: "a-different-id",
    msg: "Readable but not navigable",
  } }))).toEqual({ text: "Readable but not navigable" });
  expect(extractQuotePreview(message({ quote: { globalMsgId: 123, msg: { msg: "not a string" } } }))).toBeUndefined();
});

it("reads the live undo target instead of the ID of the undo envelope", () => {
  const target = jsonBig.parse("950000000000000002");
  const content = { globalMsgId: target, cliMsgId: "cli-1", deleteMsg: 1 };
  const direct = { threadId: "peer-1", isGroup: false, isSelf: false,
    data: { msgId: "undo-event", uidFrom: "peer-1", idTo: "account-1", content } };
  expect(extractUndoTarget(direct)).toEqual({ threadId: "peer-1", threadType: "User", messageId: "950000000000000002" });

  const group = { threadId: "group-1", isGroup: true, isSelf: true,
    data: { msgId: "another-undo-event", uidFrom: "account-1", idTo: "group-1", content } };
  expect(extractUndoTarget(group)).toEqual({ threadId: "group-1", threadType: "Group", messageId: "950000000000000002" });
  const ownDirect = { ...direct, isSelf: true, data: { ...direct.data, uidFrom: "account-1", idTo: "peer-1" } };
  expect(extractUndoTarget(ownDirect)).toEqual({ threadId: "peer-1", threadType: "User", messageId: "950000000000000002" });
  expect(extractUndoTarget({ ...direct, threadId: "other-peer" })).toBeUndefined();
  expect(extractUndoTarget({ ...group, isGroup: undefined })).toBeUndefined();
  expect(extractUndoTarget({ ...group, data: { ...group.data, content: { ...content, globalMsgId: Number(target) } } })).toBeUndefined();
  expect(extractUndoTarget({ ...direct, data: { ...direct.data, content: { cliMsgId: "cli-1", deleteMsg: 1 } } })).toBeUndefined();
  expect(extractUndoTarget({ ...direct, data: { ...direct.data, content: { globalMsgId: target } } })).toBeUndefined();
});

it("quarantines undo-shaped history data without treating it as a confirmed undo", () => {
  const historyMessage = message({ content: { globalMsgId: "950000000000000002", deleteMsg: 1 } }, ThreadType.Group);
  expect(hasUnverifiedHistoryUndoShape(historyMessage)).toBe(true);
  expect(extractUndoTarget(historyMessage)).toBeUndefined();
  expect(hasUnverifiedHistoryUndoShape(message({ content: { globalMsgId: "950000000000000002" } }, ThreadType.Group))).toBe(false);
});

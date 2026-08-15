import assert from "node:assert/strict";
import test from "node:test";
import { firstLine, latestLine, reasoningSummary } from "../src/utils/reasoningSummary";

test("firstLine returns the whole text when there is no newline", () => {
  assert.equal(firstLine("单行思考"), "单行思考");
});

test("firstLine cuts at the first newline", () => {
  assert.equal(firstLine("第一行\n第二行\n第三行"), "第一行");
});

test("latestLine ignores trailing whitespace before the last newline", () => {
  assert.equal(latestLine("第一行\n第二行\n"), "第二行");
});

test("latestLine returns the last line", () => {
  assert.equal(latestLine("a\nb\nc"), "c");
});

test("reasoningSummary picks the latest line while running and the first line when settled", () => {
  const text = "第一行\n第二行";
  assert.equal(reasoningSummary(text, true), "第二行");
  assert.equal(reasoningSummary(text, false), "第一行");
});

test("reasoningSummary returns an empty summary for blank text", () => {
  assert.equal(reasoningSummary(" \n ", true), "");
});

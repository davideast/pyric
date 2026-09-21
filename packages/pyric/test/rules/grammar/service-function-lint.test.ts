import { test, expect } from "bun:test";
import { firestoreRules } from "../../../src/rules/index";
test("lint resolves service-level helpers used by nested allow rules", () => {
  const rules = firestoreRules(`rules_version = '2';
service cloud.firestore {
 function authenticated() { return request.auth != null; }
 function validText() { return request.resource.data.text is string; }
 match /databases/{database}/documents {
  match /notes/{note} {
   allow create: if authenticated() && validText();
  }
 }
}`);
  expect(rules.lint().filter(i => i.severity === "error")).toEqual([]);
  expect(rules.simulate([{description:"valid note",method:"create",path:"notes/one",auth:{uid:"sam"},data:{text:"Hi"},expectation:"ALLOW"}]).passed).toBe(1);
});

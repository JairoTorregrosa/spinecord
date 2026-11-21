// workerd's test-only module (compatibility flag "unsafe_module", set in setup.ts). Only what entry.ts uses.
declare module "workerd:unsafe" {
  const unsafe: {
    evict(stub: DurableObjectStub, options: { webSockets: "hibernate" | "close" }): Promise<void>;
    deleteAllDurableObjects(): Promise<void>;
  };
  export default unsafe;
}

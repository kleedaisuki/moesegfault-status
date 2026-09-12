/** Workers 将 WASM 作为已编译模块导入。 / Workers imports WASM as compiled modules. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

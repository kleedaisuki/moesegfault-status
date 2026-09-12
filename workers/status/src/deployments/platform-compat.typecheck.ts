import type { ArtifactBucket, DeploymentDatabase } from "./types.js";

type AssertTrue<T extends true> = T;

/** 编译期保证组合根可直接传入平台 D1 binding / Compile-time proof that the platform D1 binding is accepted directly. */
export type D1BindingCompatibility = AssertTrue<
  D1Database extends DeploymentDatabase ? true : false
>;

/** 编译期保证组合根可直接传入平台 R2 binding / Compile-time proof that the platform R2 binding is accepted directly. */
export type R2BindingCompatibility = AssertTrue<
  R2Bucket extends ArtifactBucket ? true : false
>;

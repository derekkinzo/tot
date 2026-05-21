declare module 'd3-flextree' {
  import { HierarchyNode } from 'd3-hierarchy';

  interface FlextreeLayout<T> {
    (root: HierarchyNode<T>): FlextreeNode<T>;
    nodeSize(size: (node: HierarchyNode<T>) => [number, number]): this;
    spacing(fn: (a: HierarchyNode<T>, b: HierarchyNode<T>) => number): this;
  }

  interface FlextreeNode<T> extends HierarchyNode<T> {
    x: number;
    y: number;
    descendants(): FlextreeNode<T>[];
  }

  export function flextree<T>(): FlextreeLayout<T>;
}

declare module 'd3-hierarchy' {
  export interface HierarchyNode<T> {
    data: T;
    depth: number;
    height: number;
    parent: HierarchyNode<T> | null;
    children?: HierarchyNode<T>[];
    x: number;
    y: number;
    descendants(): HierarchyNode<T>[];
  }

  export function hierarchy<T>(
    data: T,
    children?: (d: T) => T[] | undefined,
  ): HierarchyNode<T>;
}

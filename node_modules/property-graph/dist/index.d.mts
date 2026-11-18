//#region src/graph-edge.d.ts
/**
 * Represents a connection between two {@link GraphNode} resources in a {@link Graph}.
 *
 * The left node is considered the owner, and the right node the resource. The
 * owner is responsible for being able find and remove a reference to a resource, given
 * that link. The resource does not hold a reference to the link or to the owner,
 * although that reverse lookup can be done on the graph.
 */
declare class GraphEdge<Parent extends GraphNode, Child extends GraphNode> {
  private _disposed;
  private readonly _name;
  private readonly _parent;
  private _child;
  private _attributes;
  constructor(_name: string, _parent: Parent, _child: Child, _attributes?: Record<string, unknown>);
  /** Name (attribute name from parent {@link GraphNode}). */
  getName(): string;
  /** Owner node. */
  getParent(): Parent;
  /** Resource node. */
  getChild(): Child;
  /**
   * Sets the child node.
   *
   * @internal Only {@link Graph} implementations may safely call this method directly. Use
   * 	{@link Property.swap} or {@link Graph.swapChild} instead.
   */
  setChild(child: Child): this;
  /** Attributes of the graph node relationship. */
  getAttributes(): Record<string, unknown>;
  /** Destroys a (currently intact) edge, updating both the graph and the owner. */
  dispose(): void;
  /** Whether this link has been destroyed. */
  isDisposed(): boolean;
}
//#endregion
//#region src/graph.d.ts
/**
 * A graph manages a network of {@link GraphNode} nodes, connected
 * by {@link @Link} edges.
 */
declare class Graph<T$1 extends GraphNode> extends EventDispatcher<GraphEvent | GraphNodeEvent | GraphEdgeEvent> {
  private _emptySet;
  private _edges;
  private _parentEdges;
  private _childEdges;
  /** Returns a list of all parent->child edges on this graph. */
  listEdges(): GraphEdge<T$1, T$1>[];
  /** Returns a list of all edges on the graph having the given node as their child. */
  listParentEdges(node: T$1): GraphEdge<T$1, T$1>[];
  /** Returns a list of parent nodes for the given child node. */
  listParents(node: T$1): T$1[];
  /** Returns a list of all edges on the graph having the given node as their parent. */
  listChildEdges(node: T$1): GraphEdge<T$1, T$1>[];
  /** Returns a list of child nodes for the given parent node. */
  listChildren(node: T$1): T$1[];
  disconnectParents(node: T$1, filter?: (n: T$1) => boolean): this;
  /**********************************************************************************************
   * Internal.
   */
  /**
   * Creates a {@link GraphEdge} connecting two {@link GraphNode} instances. Edge is returned
   * for the caller to store.
   * @param a Owner
   * @param b Resource
   * @hidden
   * @internal
   */
  _createEdge<A extends T$1, B extends T$1>(name: string, a: A, b: B, attributes?: Record<string, unknown>): GraphEdge<A, B>;
  /**
   * Detaches a {@link GraphEdge} from the {@link Graph}. Before calling this
   * method, ensure that the GraphEdge has first been detached from any
   * associated {@link GraphNode} attributes.
   * @hidden
   * @internal
   */
  _destroyEdge(edge: GraphEdge<T$1, T$1>): this;
}
//#endregion
//#region src/event-dispatcher.d.ts
interface BaseEvent {
  type: string;
  [attachment: string]: unknown;
}
interface GraphEvent extends BaseEvent {
  target: Graph<GraphNode>;
}
interface GraphNodeEvent extends BaseEvent {
  target: GraphNode;
}
interface GraphEdgeEvent extends BaseEvent {
  target: GraphEdge<GraphNode, GraphNode>;
}
type EventListener<E> = (event: E) => void;
declare class EventDispatcher<T$1 extends BaseEvent> {
  private _listeners;
  addEventListener(type: string, listener: EventListener<T$1>): this;
  removeEventListener(type: string, listener: EventListener<T$1>): this;
  dispatchEvent(event: T$1): this;
  dispose(): void;
}
//#endregion
//#region src/graph-node.d.ts
type GraphNodeAttributesInternal<Parent extends GraphNode, Attributes extends object> = { [Key in keyof Attributes]: Attributes[Key] extends GraphNode ? GraphEdge<Parent, Attributes[Key]> : Attributes[Key] extends GraphNode[] ? GraphEdge<Parent, Attributes[Key][number]>[] : Attributes[Key] extends {
  [key: string]: GraphNode;
} ? Record<string, GraphEdge<Parent, Attributes[Key][string]>> : Attributes[Key] };
declare const $attributes: unique symbol;
declare const $immutableKeys: unique symbol;
/**
 * Represents a node in a {@link Graph}.
 */
declare abstract class GraphNode<Attributes extends object = object> extends EventDispatcher<GraphNodeEvent> {
  private _disposed;
  /**
   * Internal graph used to search and maintain references.
   * @hidden
   */
  protected readonly graph: Graph<GraphNode>;
  /**
   * Attributes (literal values and GraphNode references) associated with this instance. For each
   * GraphNode reference, the attributes stores a {@link GraphEdge}. List and Map references are
   * stored as arrays and dictionaries of edges.
   * @internal
   */
  protected readonly [$attributes]: GraphNodeAttributesInternal<this, Attributes>;
  /**
   * Attributes included with `getDefaultAttributes` are considered immutable, and cannot be
   * modifed by `.setRef()`, `.copy()`, or other GraphNode methods. Both the edges and the
   * properties will be disposed with the parent GraphNode.
   *
   * Currently, only single-edge references (getRef/setRef) are supported as immutables.
   *
   * @internal
   */
  protected readonly [$immutableKeys]: Set<string>;
  constructor(graph: Graph<GraphNode>);
  /**
   * Returns default attributes for the graph node. Subclasses having any attributes (either
   * literal values or references to other graph nodes) must override this method. Literal
   * attributes should be given their default values, if any. References should generally be
   * initialized as empty (Ref → null, RefList → [], RefMap → {}) and then modified by setters.
   *
   * Any single-edge references (setRef) returned by this method will be considered immutable,
   * to be owned by and disposed with the parent node. Multi-edge references (addRef, removeRef,
   * setRefMap) cannot be returned as default attributes.
   */
  protected getDefaults(): Nullable<Attributes>;
  /**
   * Constructs and returns an object used to store a graph nodes attributes. Compared to the
   * default Attributes interface, this has two distinctions:
   *
   * 1. Slots for GraphNode<T> objects are replaced with slots for GraphEdge<this, GraphNode<T>>
   * 2. GraphNode<T> objects provided as defaults are considered immutable
   *
   * @internal
   */
  private _createAttributes;
  /** @internal Returns true if two nodes are on the same {@link Graph}. */
  isOnGraph(other: GraphNode): boolean;
  /** Returns true if the node has been permanently removed from the graph. */
  isDisposed(): boolean;
  /**
   * Removes both inbound references to and outbound references from this object. At the end
   * of the process the object holds no references, and nothing holds references to it. A
   * disposed object is not reusable.
   */
  dispose(): void;
  /**
   * Removes all inbound references to this object. At the end of the process the object is
   * considered 'detached': it may hold references to child resources, but nothing holds
   * references to it. A detached object may be re-attached.
   */
  detach(): this;
  /**
   * Transfers this object's references from the old node to the new one. The old node is fully
   * detached from this parent at the end of the process.
   *
   * @hidden
   */
  swap(prevValue: GraphNode, nextValue: GraphNode): this;
  /**********************************************************************************************
   * Literal attributes.
   */
  /** @hidden */
  protected get<K$1 extends LiteralKeys<Attributes>>(attribute: K$1): Attributes[K$1];
  /** @hidden */
  protected set<K$1 extends LiteralKeys<Attributes>>(attribute: K$1, value: Attributes[K$1]): this;
  /**********************************************************************************************
   * Ref: 1:1 graph node references.
   */
  /** @hidden */
  protected getRef<K$1 extends RefKeys<Attributes>>(attribute: K$1): (GraphNode & Attributes[K$1]) | null;
  /** @hidden */
  protected setRef<K$1 extends RefKeys<Attributes>>(attribute: K$1, value: (GraphNode & Attributes[K$1]) | null, attributes?: Record<string, unknown>): this;
  /**********************************************************************************************
   * RefList: 1:many graph node references.
   */
  /** @hidden */
  protected listRefs<K$1 extends RefListKeys<Attributes> | RefSetKeys<Attributes>>(attribute: K$1): RefCollectionValue<Attributes[K$1]>[];
  /** @hidden */
  protected addRef<K$1 extends RefListKeys<Attributes> | RefSetKeys<Attributes>>(attribute: K$1, value: RefCollectionValue<Attributes[K$1]>, attributes?: Record<string, unknown>): this;
  /** @hidden */
  protected removeRef<K$1 extends RefListKeys<Attributes> | RefSetKeys<Attributes>>(attribute: K$1, value: RefCollectionValue<Attributes[K$1]>): this;
  /** @hidden */
  private assertRefList;
  /**********************************************************************************************
   * RefMap: Named 1:many (map) graph node references.
   */
  /** @hidden */
  protected listRefMapKeys<K$1 extends RefMapKeys<Attributes>>(attribute: K$1): string[];
  /** @hidden */
  protected listRefMapValues<K$1 extends RefMapKeys<Attributes>, V$1 extends RefMapValue<Attributes[K$1]>>(attribute: K$1): V$1[];
  /** @hidden */
  protected getRefMap<K$1 extends RefMapKeys<Attributes>, V$1 extends RefMapValue<Attributes[K$1]>>(attribute: K$1, key: string): V$1 | null;
  /** @hidden */
  protected setRefMap<K$1 extends RefMapKeys<Attributes>, V$1 extends RefMapValue<Attributes[K$1]>>(attribute: K$1, key: string, value: V$1 | null, metadata?: Record<string, unknown>): this;
  /** @hidden */
  private assertRefMap;
  /**********************************************************************************************
   * Events.
   */
  /**
   * Dispatches an event on the GraphNode, and on the associated
   * Graph. Event types on the graph are prefixed, `"node:[type]"`.
   */
  dispatchEvent(event: BaseEvent): this;
  /**********************************************************************************************
   * Internal.
   */
  /** @hidden */
  _destroyRef<K$1 extends RefKeys<Attributes> | RefListKeys<Attributes> | RefSetKeys<Attributes> | RefMapKeys<Attributes>>(ref: GraphEdge<this, GraphNode & Attributes[K$1]>): void;
}
//#endregion
//#region src/refs.d.ts
type Ref<T$1 extends GraphNode = GraphNode> = GraphEdge<GraphNode, T$1>;
/**
 * An ordered collection of {@link Ref Refs}, allowing duplicates. Removing
 * a Ref is an O(n) operation — use {@link RefSet} for faster removal, if
 * duplicates are not required.
 */
declare class RefList<T$1 extends GraphNode = GraphNode> {
  list: Ref<T$1>[];
  constructor(refs?: Ref<T$1>[]);
  add(ref: Ref<T$1>): void;
  remove(ref: Ref<T$1>): void;
  removeChild(child: T$1): Ref<T$1>[];
  listRefsByChild(child: T$1): Ref<T$1>[];
  values(): Ref<T$1>[];
}
/**
 * An ordered collection of {@link Ref Refs}, without duplicates. Adding or
 * removing a Ref is typically O(1) or O(log(n)), and faster than
 * {@link RefList}. If support for duplicates is required, use {@link RefList}.
 */
declare class RefSet<T$1 extends GraphNode = GraphNode> {
  set: Set<Ref<T$1>>;
  map: Map<T$1, Ref<T$1>>;
  constructor(refs?: Ref<T$1>[]);
  add(ref: Ref<T$1>): void;
  remove(ref: Ref<T$1>): void;
  removeChild(child: T$1): Ref<T$1> | null;
  getRefByChild(child: T$1): Ref<T$1> | null;
  values(): Ref<T$1>[];
}
/**
 * Map (or dictionary) from string keys to {@link Ref Refs}.
 */
declare class RefMap<T$1 extends GraphNode = GraphNode> {
  map: {
    [key: string]: Ref<T$1>;
  };
  constructor(map?: Record<string, Ref<T$1>>);
  set(key: string, child: Ref<T$1>): void;
  delete(key: string): void;
  get(key: string): Ref<T$1> | null;
  keys(): string[];
  values(): Ref<T$1>[];
}
//#endregion
//#region src/constants.d.ts
/** TypeScript utility for nullable types. */
type Nullable<T$1> = { [P in keyof T$1]: T$1[P] | null };
type Literal = null | boolean | boolean[] | boolean[][] | string | string[] | string[][] | number | number[] | number[][] | ArrayBuffer | ArrayBufferView | Record<string, unknown>;
type LiteralKeys<T$1> = { [K in keyof T$1]-?: T$1[K] extends Literal ? K : never }[keyof T$1];
type RefKeys<T$1> = { [K in keyof T$1]-?: T$1[K] extends GraphNode ? K : never }[keyof T$1];
type RefListKeys<T$1> = { [K in keyof T$1]-?: T$1[K] extends RefList ? K : never }[keyof T$1];
type RefListValue<List> = List extends RefList<infer V> ? V : never;
type RefSetKeys<T$1> = { [K in keyof T$1]-?: T$1[K] extends RefSet ? K : never }[keyof T$1];
type RefSetValue<Set$1> = Set$1 extends RefSet<infer V> ? V : never;
type RefMapKeys<T$1> = { [K in keyof T$1]-?: T$1[K] extends RefMap ? K : never }[keyof T$1];
type RefMapValue<Map$1> = Map$1 extends RefMap<infer V> ? V : never;
type RefCollectionValue<Collection> = Collection extends RefList<infer T> | RefSet<infer T> | RefMap<infer T> ? T : never;
//#endregion
export { $attributes, $immutableKeys, BaseEvent, EventDispatcher, EventListener, Graph, GraphEdge, GraphEdgeEvent, GraphEvent, GraphNode, GraphNodeEvent, Literal, LiteralKeys, Nullable, Ref, RefCollectionValue, RefKeys, RefList, RefListKeys, RefListValue, RefMap, RefMapKeys, RefMapValue, RefSet, RefSetKeys, RefSetValue };
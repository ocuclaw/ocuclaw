//#region src/event-dispatcher.ts
var EventDispatcher = class {
	_listeners = {};
	addEventListener(type, listener) {
		const listeners = this._listeners;
		if (listeners[type] === void 0) listeners[type] = [];
		if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener);
		return this;
	}
	removeEventListener(type, listener) {
		const listenerArray = this._listeners[type];
		if (listenerArray !== void 0) {
			const index = listenerArray.indexOf(listener);
			if (index !== -1) listenerArray.splice(index, 1);
		}
		return this;
	}
	dispatchEvent(event) {
		const listenerArray = this._listeners[event.type];
		if (listenerArray !== void 0) {
			const array = listenerArray.slice(0);
			for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event);
		}
		return this;
	}
	dispose() {
		for (const key in this._listeners) delete this._listeners[key];
	}
};

//#endregion
//#region src/graph-edge.ts
/**
* Represents a connection between two {@link GraphNode} resources in a {@link Graph}.
*
* The left node is considered the owner, and the right node the resource. The
* owner is responsible for being able find and remove a reference to a resource, given
* that link. The resource does not hold a reference to the link or to the owner,
* although that reverse lookup can be done on the graph.
*/
var GraphEdge = class {
	_disposed = false;
	_name;
	_parent;
	_child;
	_attributes;
	constructor(_name, _parent, _child, _attributes = {}) {
		this._name = _name;
		this._parent = _parent;
		this._child = _child;
		this._attributes = _attributes;
		if (!_parent.isOnGraph(_child)) throw new Error("Cannot connect disconnected graphs.");
	}
	/** Name (attribute name from parent {@link GraphNode}). */
	getName() {
		return this._name;
	}
	/** Owner node. */
	getParent() {
		return this._parent;
	}
	/** Resource node. */
	getChild() {
		return this._child;
	}
	/**
	* Sets the child node.
	*
	* @internal Only {@link Graph} implementations may safely call this method directly. Use
	* 	{@link Property.swap} or {@link Graph.swapChild} instead.
	*/
	setChild(child) {
		this._child = child;
		return this;
	}
	/** Attributes of the graph node relationship. */
	getAttributes() {
		return this._attributes;
	}
	/** Destroys a (currently intact) edge, updating both the graph and the owner. */
	dispose() {
		if (this._disposed) return;
		this._parent._destroyRef(this);
		this._disposed = true;
	}
	/** Whether this link has been destroyed. */
	isDisposed() {
		return this._disposed;
	}
};

//#endregion
//#region src/graph.ts
/**
* A graph manages a network of {@link GraphNode} nodes, connected
* by {@link @Link} edges.
*/
var Graph = class extends EventDispatcher {
	_emptySet = /* @__PURE__ */ new Set();
	_edges = /* @__PURE__ */ new Set();
	_parentEdges = /* @__PURE__ */ new Map();
	_childEdges = /* @__PURE__ */ new Map();
	/** Returns a list of all parent->child edges on this graph. */
	listEdges() {
		return Array.from(this._edges);
	}
	/** Returns a list of all edges on the graph having the given node as their child. */
	listParentEdges(node) {
		return Array.from(this._childEdges.get(node) || this._emptySet);
	}
	/** Returns a list of parent nodes for the given child node. */
	listParents(node) {
		const parentSet = /* @__PURE__ */ new Set();
		for (const edge of this.listParentEdges(node)) parentSet.add(edge.getParent());
		return Array.from(parentSet);
	}
	/** Returns a list of all edges on the graph having the given node as their parent. */
	listChildEdges(node) {
		return Array.from(this._parentEdges.get(node) || this._emptySet);
	}
	/** Returns a list of child nodes for the given parent node. */
	listChildren(node) {
		const childSet = /* @__PURE__ */ new Set();
		for (const edge of this.listChildEdges(node)) childSet.add(edge.getChild());
		return Array.from(childSet);
	}
	disconnectParents(node, filter) {
		for (const edge of this.listParentEdges(node)) if (!filter || filter(edge.getParent())) edge.dispose();
		return this;
	}
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
	_createEdge(name, a, b, attributes) {
		const edge = new GraphEdge(name, a, b, attributes);
		this._edges.add(edge);
		const parent = edge.getParent();
		if (!this._parentEdges.has(parent)) this._parentEdges.set(parent, /* @__PURE__ */ new Set());
		this._parentEdges.get(parent).add(edge);
		const child = edge.getChild();
		if (!this._childEdges.has(child)) this._childEdges.set(child, /* @__PURE__ */ new Set());
		this._childEdges.get(child).add(edge);
		return edge;
	}
	/**
	* Detaches a {@link GraphEdge} from the {@link Graph}. Before calling this
	* method, ensure that the GraphEdge has first been detached from any
	* associated {@link GraphNode} attributes.
	* @hidden
	* @internal
	*/
	_destroyEdge(edge) {
		this._edges.delete(edge);
		this._parentEdges.get(edge.getParent()).delete(edge);
		this._childEdges.get(edge.getChild()).delete(edge);
		return this;
	}
};

//#endregion
//#region src/refs.ts
/**
* An ordered collection of {@link Ref Refs}, allowing duplicates. Removing
* a Ref is an O(n) operation — use {@link RefSet} for faster removal, if
* duplicates are not required.
*/
var RefList = class {
	list = [];
	constructor(refs) {
		if (refs) for (const ref of refs) this.list.push(ref);
	}
	add(ref) {
		this.list.push(ref);
	}
	remove(ref) {
		const index = this.list.indexOf(ref);
		if (index >= 0) this.list.splice(index, 1);
	}
	removeChild(child) {
		const refs = [];
		for (const ref of this.list) if (ref.getChild() === child) refs.push(ref);
		for (const ref of refs) this.remove(ref);
		return refs;
	}
	listRefsByChild(child) {
		const refs = [];
		for (const ref of this.list) if (ref.getChild() === child) refs.push(ref);
		return refs;
	}
	values() {
		return this.list;
	}
};
/**
* An ordered collection of {@link Ref Refs}, without duplicates. Adding or
* removing a Ref is typically O(1) or O(log(n)), and faster than
* {@link RefList}. If support for duplicates is required, use {@link RefList}.
*/
var RefSet = class {
	set = /* @__PURE__ */ new Set();
	map = /* @__PURE__ */ new Map();
	constructor(refs) {
		if (refs) for (const ref of refs) this.add(ref);
	}
	add(ref) {
		const child = ref.getChild();
		this.removeChild(child);
		this.set.add(ref);
		this.map.set(child, ref);
	}
	remove(ref) {
		this.set.delete(ref);
		this.map.delete(ref.getChild());
	}
	removeChild(child) {
		const ref = this.map.get(child) || null;
		if (ref) this.remove(ref);
		return ref;
	}
	getRefByChild(child) {
		return this.map.get(child) || null;
	}
	values() {
		return Array.from(this.set);
	}
};
/**
* Map (or dictionary) from string keys to {@link Ref Refs}.
*/
var RefMap = class {
	map = {};
	constructor(map) {
		if (map) Object.assign(this.map, map);
	}
	set(key, child) {
		this.map[key] = child;
	}
	delete(key) {
		delete this.map[key];
	}
	get(key) {
		return this.map[key] || null;
	}
	keys() {
		return Object.keys(this.map);
	}
	values() {
		return Object.values(this.map);
	}
};

//#endregion
//#region src/graph-node.ts
const $attributes = Symbol("attributes");
const $immutableKeys = Symbol("immutableKeys");
/**
* Represents a node in a {@link Graph}.
*/
var GraphNode = class GraphNode extends EventDispatcher {
	_disposed = false;
	/**
	* Internal graph used to search and maintain references.
	* @hidden
	*/
	graph;
	/**
	* Attributes (literal values and GraphNode references) associated with this instance. For each
	* GraphNode reference, the attributes stores a {@link GraphEdge}. List and Map references are
	* stored as arrays and dictionaries of edges.
	* @internal
	*/
	[$attributes];
	/**
	* Attributes included with `getDefaultAttributes` are considered immutable, and cannot be
	* modifed by `.setRef()`, `.copy()`, or other GraphNode methods. Both the edges and the
	* properties will be disposed with the parent GraphNode.
	*
	* Currently, only single-edge references (getRef/setRef) are supported as immutables.
	*
	* @internal
	*/
	[$immutableKeys];
	constructor(graph) {
		super();
		this.graph = graph;
		this[$immutableKeys] = /* @__PURE__ */ new Set();
		this[$attributes] = this._createAttributes();
	}
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
	getDefaults() {
		return {};
	}
	/**
	* Constructs and returns an object used to store a graph nodes attributes. Compared to the
	* default Attributes interface, this has two distinctions:
	*
	* 1. Slots for GraphNode<T> objects are replaced with slots for GraphEdge<this, GraphNode<T>>
	* 2. GraphNode<T> objects provided as defaults are considered immutable
	*
	* @internal
	*/
	_createAttributes() {
		const defaultAttributes = this.getDefaults();
		const attributes = {};
		for (const key in defaultAttributes) {
			const value = defaultAttributes[key];
			if (value instanceof GraphNode) {
				const ref = this.graph._createEdge(key, this, value);
				this[$immutableKeys].add(key);
				attributes[key] = ref;
			} else attributes[key] = value;
		}
		return attributes;
	}
	/** @internal Returns true if two nodes are on the same {@link Graph}. */
	isOnGraph(other) {
		return this.graph === other.graph;
	}
	/** Returns true if the node has been permanently removed from the graph. */
	isDisposed() {
		return this._disposed;
	}
	/**
	* Removes both inbound references to and outbound references from this object. At the end
	* of the process the object holds no references, and nothing holds references to it. A
	* disposed object is not reusable.
	*/
	dispose() {
		if (this._disposed) return;
		this.graph.listChildEdges(this).forEach((edge) => edge.dispose());
		this.graph.disconnectParents(this);
		this._disposed = true;
		this.dispatchEvent({ type: "dispose" });
	}
	/**
	* Removes all inbound references to this object. At the end of the process the object is
	* considered 'detached': it may hold references to child resources, but nothing holds
	* references to it. A detached object may be re-attached.
	*/
	detach() {
		this.graph.disconnectParents(this);
		return this;
	}
	/**
	* Transfers this object's references from the old node to the new one. The old node is fully
	* detached from this parent at the end of the process.
	*
	* @hidden
	*/
	swap(prevValue, nextValue) {
		for (const attribute in this[$attributes]) {
			const value = this[$attributes][attribute];
			if (value instanceof GraphEdge) {
				const ref = value;
				if (ref.getChild() === prevValue) this.setRef(attribute, nextValue, ref.getAttributes());
			} else if (value instanceof RefList) for (const ref of value.listRefsByChild(prevValue)) {
				const refAttributes = ref.getAttributes();
				this.removeRef(attribute, prevValue);
				this.addRef(attribute, nextValue, refAttributes);
			}
			else if (value instanceof RefSet) {
				const ref = value.getRefByChild(prevValue);
				if (ref) {
					const refAttributes = ref.getAttributes();
					this.removeRef(attribute, prevValue);
					this.addRef(attribute, nextValue, refAttributes);
				}
			} else if (value instanceof RefMap) for (const key of value.keys()) {
				const ref = value.get(key);
				if (ref.getChild() === prevValue) this.setRefMap(attribute, key, nextValue, ref.getAttributes());
			}
		}
		return this;
	}
	/**********************************************************************************************
	* Literal attributes.
	*/
	/** @hidden */
	get(attribute) {
		return this[$attributes][attribute];
	}
	/** @hidden */
	set(attribute, value) {
		this[$attributes][attribute] = value;
		return this.dispatchEvent({
			type: "change",
			attribute
		});
	}
	/**********************************************************************************************
	* Ref: 1:1 graph node references.
	*/
	/** @hidden */
	getRef(attribute) {
		const ref = this[$attributes][attribute];
		return ref ? ref.getChild() : null;
	}
	/** @hidden */
	setRef(attribute, value, attributes) {
		if (this[$immutableKeys].has(attribute)) throw new Error(`Cannot overwrite immutable attribute, "${attribute}".`);
		const prevRef = this[$attributes][attribute];
		if (prevRef) prevRef.dispose();
		if (!value) return this;
		const ref = this.graph._createEdge(attribute, this, value, attributes);
		this[$attributes][attribute] = ref;
		return this.dispatchEvent({
			type: "change",
			attribute
		});
	}
	/**********************************************************************************************
	* RefList: 1:many graph node references.
	*/
	/** @hidden */
	listRefs(attribute) {
		return this.assertRefList(attribute).values().map((ref) => ref.getChild());
	}
	/** @hidden */
	addRef(attribute, value, attributes) {
		const ref = this.graph._createEdge(attribute, this, value, attributes);
		this.assertRefList(attribute).add(ref);
		return this.dispatchEvent({
			type: "change",
			attribute
		});
	}
	/** @hidden */
	removeRef(attribute, value) {
		const refs = this.assertRefList(attribute);
		if (refs instanceof RefList) for (const ref of refs.listRefsByChild(value)) ref.dispose();
		else {
			const ref = refs.getRefByChild(value);
			if (ref) ref.dispose();
		}
		return this;
	}
	/** @hidden */
	assertRefList(attribute) {
		const refs = this[$attributes][attribute];
		if (refs instanceof RefList || refs instanceof RefSet) return refs;
		throw new Error(`Expected RefList or RefSet for attribute "${attribute}"`);
	}
	/**********************************************************************************************
	* RefMap: Named 1:many (map) graph node references.
	*/
	/** @hidden */
	listRefMapKeys(attribute) {
		return this.assertRefMap(attribute).keys();
	}
	/** @hidden */
	listRefMapValues(attribute) {
		return this.assertRefMap(attribute).values().map((ref) => ref.getChild());
	}
	/** @hidden */
	getRefMap(attribute, key) {
		const ref = this.assertRefMap(attribute).get(key);
		return ref ? ref.getChild() : null;
	}
	/** @hidden */
	setRefMap(attribute, key, value, metadata) {
		const refMap = this.assertRefMap(attribute);
		const prevRef = refMap.get(key);
		if (prevRef) prevRef.dispose();
		if (!value) return this;
		metadata = Object.assign(metadata || {}, { key });
		const ref = this.graph._createEdge(attribute, this, value, {
			...metadata,
			key
		});
		refMap.set(key, ref);
		return this.dispatchEvent({
			type: "change",
			attribute,
			key
		});
	}
	/** @hidden */
	assertRefMap(attribute) {
		const map = this[$attributes][attribute];
		if (map instanceof RefMap) return map;
		throw new Error(`Expected RefMap for attribute "${attribute}"`);
	}
	/**********************************************************************************************
	* Events.
	*/
	/**
	* Dispatches an event on the GraphNode, and on the associated
	* Graph. Event types on the graph are prefixed, `"node:[type]"`.
	*/
	dispatchEvent(event) {
		super.dispatchEvent({
			...event,
			target: this
		});
		this.graph.dispatchEvent({
			...event,
			target: this,
			type: `node:${event.type}`
		});
		return this;
	}
	/**********************************************************************************************
	* Internal.
	*/
	/** @hidden */
	_destroyRef(ref) {
		const attribute = ref.getName();
		if (this[$attributes][attribute] === ref) {
			this[$attributes][attribute] = null;
			if (this[$immutableKeys].has(attribute)) ref.getChild().dispose();
		} else if (this[$attributes][attribute] instanceof RefList) this[$attributes][attribute].remove(ref);
		else if (this[$attributes][attribute] instanceof RefSet) this[$attributes][attribute].remove(ref);
		else if (this[$attributes][attribute] instanceof RefMap) {
			const refMap = this[$attributes][attribute];
			for (const key of refMap.keys()) if (refMap.get(key) === ref) refMap.delete(key);
		} else return;
		this.graph._destroyEdge(ref);
		this.dispatchEvent({
			type: "change",
			attribute
		});
	}
};

//#endregion
export { $attributes, $immutableKeys, EventDispatcher, Graph, GraphEdge, GraphNode, RefList, RefMap, RefSet };
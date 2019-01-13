/*
    Object pooling - Allow creation and reusability of objects without instantiation.

    Usage:
		Recycler.wrap(<Class>, <initFunction>);
		<Class>.create(...);	<= create a class
		<obj>.recycle();		<= recycle object for reuse
		<obj>.recycled = true 	<= indicates that an object has been recycled

	Example:
		Recycler.wrap(Sprite, (x, y) => {
			this.x = x;
			this.y = y;
		});

		const sprite = Recycler.create(x, y);
		//	use sprite
		sprite.recycle();

		if (sprite.recycled) {
			//	sprite is not valid
		}
 */
function Recycler() {
}

Recycler.wrap = function(classObj, initFunction) {
	const bin = [];
	classObj.create = function() {
		const obj = bin.length ? bin.pop() : new classObj();
		initFunction.apply(obj, arguments);
		obj.recycled = false;
		return obj;
	};	

	classObj.prototype.recycle = function() {
		bin.push(this);
		this.recycled = true;
	};
}

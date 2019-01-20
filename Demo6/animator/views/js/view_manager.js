const View = (function() {
	const SLOWDOWN = .75;
	const SPEED_FACTOR = .02;
	const MOVE_MULTIPLIER = 2;
	const ROTATION_STEP = 45 * Math.PI / 180;
	const ROTATION_SPEED = .02;
	const Z_OFFSET = -1.5;

	function Camera() {};
	Recycler.wrap(Camera, function(x, y, z, turn, tilt) {
		this.position = vec3.fromValues(x||0,y||0,z||0);
		this.turn = turn||0;
		this.tilt = tilt||0;
		this.autoTilt = false;
		this.motion = vec3.create();
		this.turnMotion = 0;
		this.mov = {
			dx: 0, dy: 0, dz: 0, rot: 0,
		};
		this.zOffset = Z_OFFSET;
		this.temp = {
			position: vec3.create(),
		};
		this.moveDirection = { x: 0, z: 0 };
	});

	Utils.createAccessors(Camera, ['autoTilt']);

	Camera.prototype.getTilt = function() {
		return this.autoTilt ? this.position[1] / 2 : this.tilt;
	}

	Camera.prototype.equals = function(camera) {
		if(!vec3.equals(this.position, camera.position)) {
			return false;
		}
		if(this.turn !== camera.turn || this.getTilt() !== camera.getTilt()) {
			return false;
		}
		return true;
	}

	Camera.prototype.move = function(dx, dy, dz) {
		this.mov.dx += dx;
		this.mov.dy += dy;
		this.mov.dz += dz;
	};

	Camera.prototype.rotate = function(rot) {
		this.mov.rot += rot;
	};

	Camera.prototype.getRelativePosition = function(offsetX, offsetY, offsetZ) {
	    const sin = Math.sin(this.turn);
	    const cos = Math.cos(this.turn);
	    const rdx = (cos * offsetX - sin * offsetZ);
	    const rdz = (sin * offsetX + cos * offsetZ);
	    const position = this.temp.position;
	    position[0] = this.position[0] + rdx;
	    position[1] = this.position[1] + offsetY;
	    position[2] = this.position[2] + Z_OFFSET + rdz;
	    return position;
	};

	Camera.prototype.step = function(scene) {
		const { dx, dy, dz, rot } = this.mov;
	    if (rot) {
			this.turnMotion = (this.turnMotion + rot * ROTATION_SPEED) * SLOWDOWN;
			this.mov.rot = 0;
	    } else if(this.turnMotion) {
			const closestRotation = this.turnMotion > 0 
				? Math.ceil(this.turn / ROTATION_STEP) * ROTATION_STEP
				: Math.floor(this.turn / ROTATION_STEP) * ROTATION_STEP;
			this.turnMotion = (closestRotation - this.turn) * .25;
			if(Math.abs(this.turnMotion) < .001) {
				this.turn = closestRotation;
				this.turnMotion = 0;
			}
	    }

	    const sin = Math.sin(this.turn);
	    const cos = Math.cos(this.turn);
	    const rdx = (cos * dx - sin * dz) * MOVE_MULTIPLIER;
	    const rdz = (sin * dx + cos * dz) * MOVE_MULTIPLIER;
	    this.motion[0] = (this.motion[0] + rdx) * SLOWDOWN;
	    this.motion[2] = (this.motion[2] + rdz) * SLOWDOWN;
		this.mov.dx = 0;
		this.mov.dy = 0;
		this.mov.dz = 0;

	    const [ x, y, z ] = this.position;
	    if(this.motion[0]!==0 || this.motion[2]!==0) {
		    const xDest = x + this.motion[0] * SPEED_FACTOR;
		    const zDest = z + this.motion[2] * SPEED_FACTOR;
		    if(!scene || scene.canGo(x, z + Z_OFFSET, xDest, zDest + Z_OFFSET)) {
			    this.position[0] = xDest;
			    this.position[2] = zDest;
		    } else if(scene.canGo(x, z + Z_OFFSET, x, zDest + Z_OFFSET)) {
			    this.position[2] = zDest;
		    } else if(scene.canGo(x, z + Z_OFFSET, xDest, z + Z_OFFSET)) {
		    	this.position[0] = xDest;
		    }
		    this.moveDirection.x = (x - xDest);
		    this.moveDirection.z = (z - zDest);
	    }

	    if (this.turnMotion) {
	    	this.turn += this.turnMotion;
	    }
	};

	return {
		Camera,
	};
})();

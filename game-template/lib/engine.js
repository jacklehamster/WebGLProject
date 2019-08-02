injector.register("engine", [ 
	"gl", "utils", "keyboard", "texture-manager", "sprite", "camera",
	(gl, Utils, Keyboard, textureManager, Sprite, Camera) => {
		const TEXTURE_SIZE = injector.get("texture-size");
		const INDEX_ARRAY_PER_SPRITE = new Uint16Array([
			0,  1,  2,
			0,  2,  3,
		]);

		const FLOAT_PER_VERTEX 			= 3;	//	x,y,z
		const TEXTURE_FLOAT_PER_VERTEX 	= 2;	//	x,y
		const VERTICES_PER_SPRITE 		= 4;	//	4 corners

		const IDENTITY_QUAT = quat.identity(quat.create());
		const ZERO_VEC3 = vec3.create();
		const SCALE_VEC3 = vec3.fromValues(1, 1, 1);
		const vec3temp = vec3.create(), vec3temp2 = vec3.create();

		const CORNERS = Float32Array.from([0, 1, 2, 3 ]);
		const CORNERS_FUNC = () => CORNERS;

		const SIZE_INCREASE = 500;

		const canProjectionMatrixChange = false;

		let renderer;

		const ACCELERATION = .5;
		const ROTATION_SPEED = .1;
		const MOVE_SPEED = .15;

		const cam = new Camera();

		const globalData = {
			now: 0, cam,
		};

		const debug = { globalData };

		const sprites = [];
		const dirtySprites = [];

		let lastRot = 0;

		let viewMatrix = null;
		let projectionMatrix = null;
		let cameraRotationMatrix = null;

		const glTextures = [];
		const cellCache = {	};

		let gamePaused = true;
		let background = 0xffffff;

		class Engine {
			constructor() {
				this.initGL(gl);
				this.initializeRenderer();
				addEventListener("focus", () => this.refreshPause());
				addEventListener("blur", () => this.refreshPause());
			}

			start() {
				gamePaused = false;
				this.createLoop(now => this.refresh(now));
			}

			refreshPause() {
				const focused = document.hasFocus();
				if (gamePaused === focused) {
					gamePaused = !focused;
					if (!gamePaused) {
						this.start();
					}
				}
			}

			createLoop(callback) {
				function step(timestamp) {
					if (!gamePaused) {
						callback(timestamp);
					    requestAnimationFrame(step);
					}
				}
				requestAnimationFrame(step);
			}

			initializeRenderer() {
				this.fetchRenderer(gl).then(r => renderer = r);
			}

			refresh(now) {
				if (renderer && !gamePaused) {
					globalData.now = now;
					this.refreshMove();
					const realSpritesCount = this.reorderSprites();
					this.refreshSprites(now, sprites, realSpritesCount);
				}

				if (Utils.debug) {
					this.showDebugLog();
				}
			}

			refreshSprites(now, sprites, count) {
				if (count) {
					for (let i = 0; i < count; i++) {
						const sprite = sprites[i];
						if (sprite.needsRefresh()) {
							const { id, textureIndex, chunk, pos, type, fps, timeOffset, wave } = sprite.definition;
							const textureData = textureManager.getTextureDataByIndex(this.evaluate(textureIndex, globalData, sprite))
								|| textureManager.getTextureData(this.evaluate(id, globalData, sprite));
							if (textureData.textures === null) {
								sprite.setTextureData(TextureManager.getEmptyTextureData());
							} else {
								sprite.setTextureData(textureData)
									.setPosition(this.evaluate(pos, globalData, sprite))
									.setChunk(this.evaluate(chunk, globalData, sprite))
									.setWave(this.evaluate(wave, globalData, sprite) || 0)
									.setFrameData(this.evaluate(fps, globalData, sprite) || 0, this.evaluate(timeOffset, globalData, sprite) || 0);
							}
						}
					}

					gl.uniform1f(renderer.programInfo.nowLocation, now);
					this.refreshMatrices(renderer);			
					const didBufferResized = this.ensureBuffer(renderer, count);
					textureManager.sendTexturesToGPU(renderer.shaderProgram);
					this.processSprites(renderer, sprites, count, didBufferResized);
					gl.drawElements(gl.TRIANGLES, count * INDEX_ARRAY_PER_SPRITE.length, gl.UNSIGNED_SHORT, 0);
				}
			}
			
			reorderSprites() {
				//	put recycled sprites on top. Return number of real sprites
				let topRealSpriteIndex = -1;
				for (let i = sprites.length-1; i >= 0; i--) {
					if (!sprites[i].isRecycled()) {
						topRealSpriteIndex = i;
						break;
					}
				}

				for (let i = topRealSpriteIndex-1; i >= 0; i--) {
					if (sprites[i].isRecycled()) {
						const temp = sprites[i];
						sprites[i] = sprites[topRealSpriteIndex];
						sprites[i].makeDirty();
						sprites[topRealSpriteIndex] = temp;
						topRealSpriteIndex --;
					}
				}
				return topRealSpriteIndex + 1;
			}

			setSize(width, height) {
				gl.viewport(0, 0, width, height);
			}

			setCameraSettings({ height, distance }) {
				this.cameraDistance = distance;
				this.cameraHeight = height;
			}

			setMoveSettings({ angleStep, scale, onMove }) {
				this.moveSettings = {
					angleStep, scale, onMove,
				};
			}

			refreshMove() {
				const { ax, ay, rot } = Keyboard.getActions();
				const { mov, pos } = cam;
				const { angleStep, scale, onMove } = this.moveSettings;
				cam.addMove(- ax * ACCELERATION, 0, ay * ACCELERATION);

				if (rot) {
					cam.rotate(rot * ROTATION_SPEED * .5);
					lastRot = rot;
				} else if (lastRot) {
					const goal = lastRot < 0 ? Math.floor(cam.rotation / angleStep) * angleStep :
						Math.ceil(cam.rotation / angleStep) * angleStep;
					cam.rotate((goal - cam.rotation) /8);
					if (Math.abs(cam.rotation - goal) < .001) {
						cam.setRotation(goal);
						lastRot = 0;
					}
				}

				const [ directionX, directionY, directionZ ] = cam.getRelativeDirection();
				const [ preX, preY, preZ ] = pos;
				pos[0] += directionX * MOVE_SPEED;
				pos[1] += directionY * MOVE_SPEED;
				pos[2] += directionZ * MOVE_SPEED;

				if (Math.floor(preX) !== Math.floor(pos[0]) || Math.floor(preZ) !== Math.floor(pos[2])) {
					if (Utils.debug) {
						debug.mapCell = (pos.map(Math.floor));
					}
				}

				if (viewMatrix) {
					const h = this.cameraHeight || 0;
					const { cameraQuat } = renderer;
					const turn = cam.rotation;
					const tilt = h/2;
					const zOffset = -this.cameraDistance || 0;
					quat.rotateY(cameraQuat, quat.rotateX(cameraQuat, IDENTITY_QUAT, tilt), turn);
					mat4.fromRotationTranslationScaleOrigin(viewMatrix, cameraQuat, ZERO_VEC3,
						vec3.set(vec3temp2, scale, scale, scale), vec3.set(vec3temp, 0, h, zOffset));			
					quat.conjugate(cameraQuat, cameraQuat);	//	conjugate for sprites			
					mat4.translate(viewMatrix, viewMatrix, pos);

					if (cameraRotationMatrix) {
						mat4.fromQuat(cameraRotationMatrix, cameraQuat);
					}
				}

				if (onMove) {
					onMove(vec3.set(vec3temp, preX, preY, preZ), pos);
				}
			}

			showDebugLog() {
				document.getElementById("debug").style.display = "";
				document.getElementById("log").innerText = JSON.stringify(debug, null, '  ');
			}

			refreshMatrices({ cache, programInfo }) {
				if (!projectionMatrix) {
					projectionMatrix = mat4.create();
					const fieldOfView = 45 * Math.PI / 180;   // in radians
					const aspect = gl.canvas.width / gl.canvas.height;
					const zNear = 0.1, zFar = 1000.0;
					mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);
					gl.uniformMatrix4fv(programInfo.projectionLocation, false, projectionMatrix);
					cache.projectionMatrix = mat4.create();
				}
				if (canProjectionMatrixChange && !mat4.exactEquals(projectionMatrix, cache.projectionMatrix)) {
					gl.uniformMatrix4fv(programInfo.projectionLocation, false, projectionMatrix);
					mat4.copy(cache.projectionMatrix, projectionMatrix);
				}

				if (!viewMatrix) {
					const [ x, y, z ] = vec3.fromValues(0, 0, 0);
					viewMatrix = mat4.create();
					mat4.translate(viewMatrix, viewMatrix, vec3.fromValues(-x, -y, -z));
					gl.uniformMatrix4fv(programInfo.viewLocation, false, viewMatrix);
					cache.viewMatrix = mat4.create();
				}
				if (!mat4.exactEquals(viewMatrix, cache.viewMatrix)) {
					gl.uniformMatrix4fv(programInfo.viewLocation, false, viewMatrix);
					mat4.copy(cache.viewMatrix, viewMatrix);
				}

				if (!cameraRotationMatrix) {
					cameraRotationMatrix = mat4.create();
					gl.uniformMatrix4fv(programInfo.cameraRotationLocation, false, cameraRotationMatrix);
					cache.cameraRotationMatrix = mat4.create();
				}
				if (!mat4.exactEquals(cameraRotationMatrix, cache.cameraRotationMatrix)) {
					gl.uniformMatrix4fv(programInfo.cameraRotationLocation, false, cameraRotationMatrix);
					mat4.copy(cache.cameraRotationMatrix, cameraRotationMatrix);
				}
			}

			initGL(gl) {
				gl.enable(gl.BLEND);
				gl.enable(gl.DEPTH_TEST);
				gl.enable(gl.CULL_FACE);

				gl.cullFace(gl.BACK);
				gl.depthFunc(gl.LEQUAL);
				gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);	
			}

			fetchRenderer(gl) {
				return new Promise((resolve, reject) => {
					const renderer = {
						gl,
						spriteBufferSize: 0,
						cache: {},
						cameraQuat: quat.create(),
					};

					Promise.all(Utils.load(["shaders/vertex-shader.glsl", "shaders/fragment-shader.glsl"]))
						.then(([vsSource, fsSource]) => {
							const shaderProgram = this.initShaderProgram(gl, vsSource, fsSource);
							gl.useProgram(shaderProgram);
							renderer.shaderProgram = shaderProgram;
							renderer.programInfo = {
								vertexLocation: 			gl.getAttribLocation(shaderProgram,  'aVertexPosition'),
								frameLocation:              gl.getAttribLocation(shaderProgram,  'aFrame'),
								waveLocation: 				gl.getAttribLocation(shaderProgram,  'aWave'),
								posLocation:                gl.getAttribLocation(shaderProgram,  'aPosition'),
								isSpriteLocation: 			gl.getAttribLocation(shaderProgram,  'aIsSprite'),
								chunkLocation:              gl.getAttribLocation(shaderProgram,  'aChunk'),
								cornerLocation:             gl.getAttribLocation(shaderProgram,  'aCorner'),
								projectionLocation: 		gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
								viewLocation: 				gl.getUniformLocation(shaderProgram, 'uViewMatrix'),
								cameraRotationLocation:     gl.getUniformLocation(shaderProgram, 'uCameraRotation'),
								nowLocation: 				gl.getUniformLocation(shaderProgram, 'now'),
								backgroundLocation:         gl.getUniformLocation(shaderProgram, 'background'),
							};
							gl.uniform1iv(gl.getUniformLocation(shaderProgram, 'uTextureSampler'), new Array(16).fill(null).map((a, index) => index));
							const r = ((background / 256 / 256) % 256) / 256;
							const g = ((background / 256) % 256) / 256;
							const b = ((background) % 256) / 256;
							gl.uniform4f(renderer.programInfo.backgroundLocation, r, g, b, 1);
						}).then(() => {
							resolve(renderer);
						});
				});
			}

			setBackground(bg) {
				background = bg;
				if(renderer) {
					const r = ((background / 256 / 256) % 256) / 256;
					const g = ((background / 256) % 256) / 256;
					const b = ((background) % 256) / 256;
					gl.uniform4f(renderer.programInfo.backgroundLocation, r, g, b, 1);
				}
			}

			getSlotIndices(slotIndex) {
				return INDEX_ARRAY_PER_SPRITE.map(value => value + slotIndex * VERTICES_PER_SPRITE);		
			}

			static bufferSprites(renderer, sprites, elementSize, spriteFunction) {
				const { gl, bigFloatArray } = renderer;
				const byteSize = elementSize * Float32Array.BYTES_PER_ELEMENT;

				let byteIndex = 0;
				let slotStart = sprites[0].slotIndex;
				let previousSlot = slotStart - 1;

				sprites.forEach(sprite => {
					const floatArray = spriteFunction(sprite);
					if (previousSlot !== sprite.slotIndex - 1) {
						gl.bufferSubData(gl.ARRAY_BUFFER, slotStart * byteSize, bigFloatArray.subarray(0, byteIndex));
						byteIndex = 0;
						slotStart = sprite.slotIndex;
					}
					bigFloatArray.set(floatArray, byteIndex);
					byteIndex += floatArray.length;
					previousSlot = sprite.slotIndex;
				});
				gl.bufferSubData(gl.ARRAY_BUFFER, slotStart * byteSize, bigFloatArray.subarray(0, byteIndex));
			}

			processSprites(renderer, sprites, count, forceRedraw) {
				if (forceRedraw) {
					sprites.forEach((sprite, slotIndex) => sprite.slotIndex = slotIndex);
					this.prepareSprites(renderer, sprites);
				} else {
					dirtySprites.length = 0;
					for (let i = 0; i < count; i++) {
						const sprite = sprites[i];
						const needsUpdate = sprite.slotIndex !== i;
						if (needsUpdate) {
							sprite.slotIndex = i;
							dirtySprites.push(sprite);
						}						
					}
					this.prepareSprites(renderer, dirtySprites);
				}
			}

			prepareSprites(renderer, dirtySprites) {
				const { 
					gl,
					indexBuffer, vertexBuffer, positionBuffer, waveBuffer,
					frameBuffer, chunkBuffer, isSpriteBuffer, cornerBuffer,
				} = renderer;

				if (dirtySprites.length) {
					gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE * FLOAT_PER_VERTEX, Sprite.getVertices);

					gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE * FLOAT_PER_VERTEX, Sprite.getPosition);

					gl.bindBuffer(gl.ARRAY_BUFFER, waveBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE, Sprite.getWave);

					gl.bindBuffer(gl.ARRAY_BUFFER, frameBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE * 4, Sprite.getFrameData);

					gl.bindBuffer(gl.ARRAY_BUFFER, isSpriteBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE, Sprite.isSprite);

					gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE, Sprite.getChunkIndex);

					gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
					Engine.bufferSprites(renderer, dirtySprites, VERTICES_PER_SPRITE, CORNERS_FUNC);
				}

				if (Utils.debug) {
					debug.draws = dirtySprites.length;
					debug.totalDraws = (debug.totalDraws || 0) + debug.draws;
					debug.spriteCount = sprites.length;
					debug.verticesCount = sprites.length * VERTICES_PER_SPRITE;
				}
			}

			createVertexAttributeBuffer(gl, location, numComponents) {
				const buffer = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
				const type = gl.FLOAT;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				gl.vertexAttribPointer(location, numComponents, type, normalize, stride, offset);
				gl.enableVertexAttribArray(location);
				return buffer;
			}

			ensureBuffer(renderer, size) {
				if (size > renderer.spriteBufferSize) {
					this.allocateBuffer(renderer, size + SIZE_INCREASE);
					return true;
				}
				return false;
			}

			allocateBuffer(renderer, size) {
				console.log("Reallocate", size);
				const { gl, programInfo, cache } = renderer;

				if (!renderer.vertexBuffer) {
					renderer.vertexBuffer = this.createVertexAttributeBuffer(gl, programInfo.vertexLocation, FLOAT_PER_VERTEX);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.vertexBuffer, size * VERTICES_PER_SPRITE * FLOAT_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT);

				if (!renderer.positionBuffer) {
					renderer.positionBuffer = this.createVertexAttributeBuffer(gl, programInfo.posLocation, 3);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.positionBuffer, size * VERTICES_PER_SPRITE * 3 * Float32Array.BYTES_PER_ELEMENT);

				if (!renderer.indexBuffer) {
					renderer.indexBuffer = gl.createBuffer();
				}
				this.resizeBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, renderer.indexBuffer, size * INDEX_ARRAY_PER_SPRITE.length * Uint16Array.BYTES_PER_ELEMENT);
				for (let i = 0; i < size; i++) {
					const slotIndices = INDEX_ARRAY_PER_SPRITE.map(value => value + i * VERTICES_PER_SPRITE);
					gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, i * slotIndices.length * Uint16Array.BYTES_PER_ELEMENT, slotIndices);
				}
				
				if (!renderer.waveBuffer) {
					renderer.waveBuffer = this.createVertexAttributeBuffer(gl, programInfo.waveLocation, 1);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.waveBuffer, size * VERTICES_PER_SPRITE * Float32Array.BYTES_PER_ELEMENT);

				if (!renderer.frameBuffer) {
					renderer.frameBuffer = this.createVertexAttributeBuffer(gl, programInfo.frameLocation, 4);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.frameBuffer, size * VERTICES_PER_SPRITE * 4 * Float32Array.BYTES_PER_ELEMENT);

				if (!renderer.isSpriteBuffer) {
					renderer.isSpriteBuffer = this.createVertexAttributeBuffer(gl, programInfo.isSpriteLocation, 1);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.isSpriteBuffer, size * VERTICES_PER_SPRITE * Float32Array.BYTES_PER_ELEMENT);

				if (!renderer.chunkBuffer) {
					renderer.chunkBuffer = this.createVertexAttributeBuffer(gl, programInfo.chunkLocation, 1);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.chunkBuffer, size * VERTICES_PER_SPRITE * Float32Array.BYTES_PER_ELEMENT);

				if (!renderer.cornerBuffer) {
					renderer.cornerBuffer = this.createVertexAttributeBuffer(gl, programInfo.cornerLocation, 1);
				}
				this.resizeBuffer(gl, gl.ARRAY_BUFFER, renderer.cornerBuffer, size * VERTICES_PER_SPRITE * Float32Array.BYTES_PER_ELEMENT);

				// biggest size
				renderer.bigFloatArray = new Float32Array(size * VERTICES_PER_SPRITE * 4 * Float32Array.BYTES_PER_ELEMENT);
				renderer.spriteBufferSize = size;
			}

			resizeBuffer(gl, bufferType, buffer, newBufferSize) {
				gl.bindBuffer(bufferType, buffer);
				const bufferSize = gl.getBufferParameter(bufferType, gl.BUFFER_SIZE);
				gl.bufferData(bufferType, newBufferSize, gl.STATIC_DRAW);
				return buffer;
			}

			loadImage(id, src, spriteSize, options) {
				textureManager.turnImageIntoTexture(id, src, spriteSize, options || {});
			}

			refreshScene(game, sceneIndex) {
				this.setupScene(game.scenes[sceneIndex]);
			}

			setupScene(scene) {
				sprites.length = 0;
				scene.spriteDefinitions.forEach(definition => this.setupSprite(definition));
			}

			evaluate(object, ...params) {
				return object && object.constructor === Function ? object(...params) : object;		
			}

			setupAsset(asset) {
				asset = this.evaluate(asset);
				if (Array.isArray(asset)) {
					asset.forEach(asset => this.setupAsset(asset));
				} else {
					const {id, src, spriteSize, options} = asset;
					this.loadImage(id, src, spriteSize, options || {});
				}
			}

			setupSprite(definition) {
				definition = this.evaluate(definition);
				if (Array.isArray(definition)) {
					definition.forEach(definition => this.setupSprite(definition));
				} else {
					this.addSprite(definition);
				}
			}

			addSprite(definition) {
				const sprite = Sprite.create().setDefinition(definition);
				if (sprite.isNew) {
					sprites.push(sprite);
				}
				return sprite;
			}

			removeSprite(sprite) {
				sprite.recycle();
			}

			initShaderProgram(gl, vsSource, fsSource) {
				const vertexShader = this.loadShader(gl, gl.VERTEX_SHADER, vsSource);
				const fragmentShader = this.loadShader(gl, gl.FRAGMENT_SHADER, fsSource);
		  
				const shaderProgram = gl.createProgram();
				gl.attachShader(shaderProgram, vertexShader);
				gl.attachShader(shaderProgram, fragmentShader);
				gl.linkProgram(shaderProgram);
		  
				if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
				  console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram));
				  return null;
				}
		  
				return shaderProgram;
			}
		    
			loadShader(gl, type, source) {
				const shader = gl.createShader(type);
				gl.shaderSource(shader, source);
				gl.compileShader(shader);
		  
				if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				  console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
				  gl.deleteShader(shader);
				  return null;
				}
				return shader;
			}
		}

		return Engine;
	}
]);



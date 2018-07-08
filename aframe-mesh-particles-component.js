// Copyright 2018 harlyq
// License MIT

(function() {

  const TIME_PARAM = 0 // [0].x
  const WORLD_RELATIVE_ID_PARAM = 1 // [0].y
  const RADIAL_PARAM = 2 // [0].z
  const DURATION_PARAM = 3 // [0].w
  const SPAWN_TYPE_PARAM = 4 // [1].x
  const SPAWN_RATE_PARAM = 5 // [1].y
  const SEED_PARAM = 6 // [1].z
  const PARTICLE_COUNT_PARAM = 7 // [1].w
  const DIRECTION_PARAM = 10 // [2].x

  const RANDOM_REPEAT_COUNT = 1048576; // random numbers will start repeating after this number of particles

  const degToRad = THREE.Math.degToRad

  // Bring all sub-array elements into a single array e.g. [[1,2],[[3],4],5] => [1,2,3,4,5]
  const flattenDeep = arr1 => arr1.reduce((acc, val) => Array.isArray(val) ? acc.concat(flattenDeep(val)) : acc.concat(val), [])

  // Convert a vector range string into an array of elements. def defines the default elements for each vector
  const parseVecRange = (str, def) => {
    let parts = str.split("..").map(a => a.trim().split(" ").map(b => b !== "" ? Number(b) : undefined))
    if (parts.length === 1) parts[1] = parts[0] // if there is no second part then copy the first part
    parts.length = 2
    return flattenDeep( parts.map(a => def.map((x,i) => typeof a[i] === "undefined" ? x : a[i])) )
  }

  // parse a ("," separated) list of vector range elements
  const parseVecRangeArray = (str, def) => {
    return flattenDeep( str.split(",").map(a => parseVecRange(a, def)) )
  }

  // parse a ("," separated) list of color range elements
  const parseColorRangeArray = (str) => {
    return flattenDeep( str.split(",").map(a => { 
      let parts = a.split("..")
      if (parts.length === 1) parts[1] = parts[0] // if there is no second part then copy the first part
      parts.length = 2
      return parts.map(b => new THREE.Color(b.trim())) 
    }) )
  }

  // find the first THREE.Mesh that is this either this object or one of it's descendants
  const getFirstMesh = (object3D) => {
    if (!object3D) {
      return
    } else if (object3D instanceof THREE.Mesh) {
      return object3D
    }

    for (let child of object3D.children) {
      let mesh = getFirstMesh(child)
      if (mesh) return mesh
    }
  }

  const toLowerCase = x => x.toLowerCase()

  // console.assert(AFRAME.utils.deepEqual(parseVecRange("", [1,2,3]), [1,2,3,1,2,3]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("5", [1,2,3]), [5,2,3,5,2,3]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("5 6", [1,2,3]), [5,6,3,5,6,3]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("5 6 7 8", [1,2,3]), [5,6,7,5,6,7]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("8 9..10", [1,2,3]), [8,9,3,10,2,3]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("..5 6 7", [1,2,3]), [1,2,3,5,6,7]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("2 3 4..5 6 7", [1,2,3]), [2,3,4,5,6,7]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRange("5 6 7..", [1,2,3]), [5,6,7,1,2,3]))

  // console.assert(AFRAME.utils.deepEqual(parseVecRangeArray("5 6 7..,9..10 11 12", [1,2,3]), [5,6,7,1,2,3,9,2,3,10,11,12]))
  // console.assert(AFRAME.utils.deepEqual(parseVecRangeArray("1,2,,,3", [10]), [1,1,2,2,10,10,10,10,3,3]))

  // console.assert(AFRAME.utils.deepEqual(parseColorRangeArray("black..red,blue,,#ff0..#00ffaa").map(a => a.getHexString()), ["000000","ff0000","0000ff","0000ff","ffffff","ffffff","ffff00","00ffaa"]))

  let uniqueID = 0 // used to make unique IDs for world relative meshes that are registered on the scene

  AFRAME.registerComponent("mesh-particles", {
    schema: {
      enableInEditor: { default: false },
      entity: { type: "selector" },
      duration: { default: -1 },
      spawnType: { default: "continuous", oneOf: ["continuous", "burst"], parse: toLowerCase },
      spawnRate: { default: 10 },
      relative: { default: "local", oneOf: ["local", "world"], parse: toLowerCase },

      lifeTime: { default: "1" },
      position: { default: "0 0 0" },
      velocity: { default: "0 0 0" },
      acceleration: { default: "0 0 0" },
      radialType: { default: "circle", oneOf: ["circle", "sphere"], parse: toLowerCase },
      radialPosition: { default: "0" },
      radialSpeed: { default: "0" },
      radialAcceleration: { default: "0" },
      angularVelocity: { default: "0 0 0" },
      angularAcceleration: { default: "0 0 0" },
      scale: { default: "1" },
      color: { default: "white", parse: toLowerCase },
      rotation: { default: "0 0 0" },
      opacity: { default: "1" },

      direction: { default: "forward", oneOf: ["forward", "backward"], parse: toLowerCase },
      seed: { type: "float", default: -1 },
      overTimeSlots: { type: "int", default: 5 },
      frustumCulled: { default: false },
      geoName: { default: "mesh" },
    },
    multiple: true,
    help: "https://github.com/harlyq/aframe-mesh-particles-component",

    init() {
      this.pauseTick = this.pauseTick.bind(this)
      this.onBeforeCompile = this.onBeforeCompile.bind(this)

      this.count = 0
      this.overTimeArrayLength = this.data.overTimeSlots*2 + 1 // each slot represents 2 glsl array elements pluse one element for the length info
      this.emitterTime = 0
      this.lifeTime = [1,1]
      this.useTransparent = false
      this.offset = new Float32Array(4*2).fill(0) // xyz is position, w is radialPosition
      this.velocity = new Float32Array(4*2).fill(0) // xyz is velocity, w is radialSpeed
      this.acceleration = new Float32Array(4*2).fill(0) // xyz is acceleration, w is radialAcceleration
      this.angularVelocity = new Float32Array(4*2).fill(0) // xyz is angularVelocity, w is lifeTime
      this.angularAcceleration = new Float32Array(4*2).fill(0) // xyz is angularAcceleration
      this.colorOverTime = new Float32Array(4*this.overTimeArrayLength).fill(0) // color is xyz and opacity is w
      this.rotationScaleOverTime = new Float32Array(4*this.overTimeArrayLength).fill(0) // xyz is rotation, w is scale
      this.params = new Float32Array(4*3).fill(0) // see _PARAM constants
      this.nextID = 0
      this.nextTime = 0
      this.relative = this.data.relative // cannot be changed at run-time
    },

    remove() {
      if (this.instancedMesh) {
        if (this.relative === "world") {
          this.el.sceneEl.removeObject3D(this.instancedMesh.uniqueName)
        } else {
          this.el.removeObject3D(this.instancedMesh.uniqueName)
        }
      } 
    },

    update(oldData) {
      const data = this.data
      
      if (data.relative !== this.relative) {
        console.error("mesh-particles 'relative' cannot be changed at run-time")
      }

      if (data.overTimeSlots !== (this.overTimeArrayLength - 1)/2) {
        console.error("mesh-particles 'overTimeSlots' cannot be changed at run-time")
      }

      this.params[RADIAL_PARAM] = data.radialType === "circle" ? 0 : 1
      this.params[DIRECTION_PARAM] = data.direction === "forward" ? 0 : 1

      if (data.seed !== oldData.seed) {
        this.seed = data.seed
        this.params[SEED_PARAM] = data.seed >= 0 ? data.seed : Math.random()
      }

      if (this.instancedMesh && data.frustumCulled !== oldData.frustumCulled) {
        this.instancedMesh.frustumCulled = data.frustumCulled
      }

      if (data.position !== oldData.position || data.radialPosition !== oldData.radialPosition) {
        this.updateVec4XYZRange(data.position, "offset")
        this.updateVec4WRange(data.radialPosition, [0], "offset")
      }

      if (data.velocity !== oldData.velocity || data.radialSpeed !== oldData.radialSpeed) {
        this.updateVec4XYZRange(data.velocity, "velocity")
        this.updateVec4WRange(data.radialSpeed, [0], "velocity")
      }

      if (data.acceleration !== oldData.acceleration || data.radialAcceleration !== oldData.radialAcceleration) {
        this.updateVec4XYZRange(data.acceleration, "acceleration")
        this.updateVec4WRange(data.radialAcceleration, [0], "acceleration")
      }

      if (data.rotation !== oldData.rotation || data.scale !== oldData.scale) {
        this.updateRotationScaleOverTime()
      }

      if (data.color !== oldData.color || data.opacity !== oldData.opacity) {
        this.updateColorOverTime()
      }

      if (data.angularVelocity !== oldData.angularVelocity || data.lifeTime !== oldData.lifeTime) {
        this.updateAngularVec4XYZRange(data.angularVelocity, "angularVelocity")
        this.lifeTime = this.updateVec4WRange(data.lifeTime, [1], "angularVelocity")
      }

      if (data.angularAcceleration !== oldData.angularAcceleration) {
        this.updateAngularVec4XYZRange(data.angularAcceleration, "angularAcceleration")
      }

      if (data.duration !== oldData.duration) {
        this.params[DURATION_PARAM] = data.duration
        this.emitterTime = 0 // if the duration is changed then restart the particles
      }

      if (data.spawnType !== oldData.spawnType || data.spawnRate !== oldData.spawnRate || data.lifeTime !== oldData.lifeTime) {
        this.params[SPAWN_TYPE_PARAM] = data.spawnType === "burst" ? 0 : 1
        this.params[SPAWN_RATE_PARAM] = data.spawnRate
        this.count = Math.max(1, this.lifeTime[1]*data.spawnRate)
        this.params[PARTICLE_COUNT_PARAM] = this.count
        this.updateAttributes()
      }

      if (data.enableInEditor !== oldData.enableInEditor) {
        this.enablePauseTick(data.enableInEditor)
      }
    },

    tick(time, deltaTime) {
      // for models it may take some time before the original mesh is available, so keep trying
      if (!this.instancedMesh) {
        this.waitingForMeshDebug = (this.waitingForMesh || 0) + deltaTime
        if (this.waitingFroMeshDebug > 2000) {
          this.waitingFroMeshDebug -= 600000
          console.error("mesh-particles missing mesh geometry")
        }

        this.createMesh()
      }

      if (this.shader) {
        if (deltaTime > 100) deltaTime = 100 // ignore long pauses
        const dt = deltaTime/1000 // dt is in seconds

        this.emitterTime += dt
        this.params[TIME_PARAM] = this.emitterTime

        this.updateWorldTransform(this.emitterTime) // before we update emitterTime
      }
    },

    pause() {
      this.enablePauseTick(this.data.enableInEditor)
    },

    play() {
      this.enablePauseTick(false)
    },

    enablePauseTick(enable) {
      if (enable) {
        this.pauseRAF = requestAnimationFrame(this.pauseTick)
      } else {
        cancelAnimationFrame(this.pauseRAF)
      }
    },

    pauseTick() {
      this.tick(0, 16) // time is not used
      this.enablePauseTick(true)
    },

    createMesh() {
      const data = this.data

      // if there is no entity property then use the geo from our component
      let mesh = getFirstMesh(data.entity ? data.entity.getObject3D(data.geoName) : this.el.getObject3D(data.geoName))

      if (!mesh || !mesh.geometry || !mesh.material) {
        return // mesh doesn't exist or not yet loaded
      }

      this.geometry = (new THREE.InstancedBufferGeometry()).copy(mesh.geometry)

      // If sourcing the particle from another entity, then bake that entities'
      // scale directly on the geo (i.e. any scale="..." applied to the entity will also be applied
      // to the particle)
      let entityScale = data.entity ? data.entity.object3D.scale : {x:1, y:1, z:1}
      this.geometry.scale(entityScale.x, entityScale.y, entityScale.z)

      this.updateAttributes()

      this.material = mesh.material.clone()
      this.wasOriginalMaterialTransparent = this.materialTransparent
      this.material.transparent = this.material.transparent || this.useTransparent

      this.material.defines = this.material.defines || {}
      this.material.defines.OVER_TIME_ARRAY_LENGTH = this.overTimeArrayLength
      this.material.defines.RANDOM_REPEAT_COUNT = RANDOM_REPEAT_COUNT

      // world relative particles use a set of new attributes, so only include the glsl code
      // if we are world relative
      if (this.relative === "world") {
        this.material.defines.WORLD_RELATIVE = true
      } else if (this.material.defines) {
        delete this.material.defines.WORLD_RELATIVE
      }

      this.material.onBeforeCompile = this.onBeforeCompile

      this.instancedMesh = new THREE.Mesh(this.geometry, this.material)
      this.instancedMesh.uniqueName = "instance" + uniqueID++
      this.instancedMesh.frustumCulled = data.frustumCulled

      if (!data.entity) {
        //mesh.visible = false // cannot just set the mesh because there may be multiple object3Ds under this geoname
        this.el.removeObject3D(data.geoName)
      }

      if (this.relative === "world") {
        this.el.sceneEl.setObject3D(this.instancedMesh.uniqueName, this.instancedMesh)
      } else {
        this.el.setObject3D(this.instancedMesh.uniqueName, this.instancedMesh)
      }

    },

    updateColorOverTime() {
      let color = parseColorRangeArray(this.data.color)
      let opacity = parseVecRangeArray(this.data.opacity, [1])

      const maxSlots = this.data.overTimeSlots
      if (color.length > maxSlots*2) color.length = maxSlots*2
      if (opacity.length > maxSlots*2) opacity.length = maxSlots*2

      this.colorOverTime.fill(0)

      // first colorOverTime block contains length information
      // divide by 2 because each array contains min and max values
      this.colorOverTime[0] = color.length/2  // glsl colorOverTime[0].x
      this.colorOverTime[1] = opacity.length/2 // glsl colorOverTime[0].y

      // set k to 4 because the first vec4 of colorOverTime is use for the length params
      let n = color.length
      for (let i = 0, k = 4; i < n; i++, k += 4) {
        let col = color[i]
        this.colorOverTime[k] = col.r // glsl colorOverTime[1..].x
        this.colorOverTime[k+1] = col.g // glsl colorOverTime[1..].y
        this.colorOverTime[k+2] = col.b // glsl colorOverTime[1..].z
      }

      n = opacity.length
      for (let i = 0, k = 4; i < n; i++, k += 4) {
        let alpha = opacity[i]
        this.colorOverTime[k+3] = alpha // glsl colorOverTime[1..].w
        this.useTransparent = this.useTransparent || alpha < 1
      }

      if (this.material) {
        this.material.transparent = this.wasOriginalMaterialTransparent || this.useTransparent // material.needsUpdate = true???
      }
    },

    updateRotationScaleOverTime() {
      const maxSlots = this.data.overTimeSlots
      let rotation = parseVecRangeArray(this.data.rotation, [0,0,0])
      let scale = parseVecRangeArray(this.data.scale, [1])


      if (rotation.length/3 > maxSlots*2) rotation.length = maxSlots*2*3 // 3 numbers per rotation, 2 rotations per range
      if (scale.length > maxSlots*2) scale.length = maxSlots*2 // 2 scales per range

      // first vec4 contains the lengths of the rotation and scale vectors
      this.rotationScaleOverTime.fill(0)
      this.rotationScaleOverTime[0] = rotation.length/6
      this.rotationScaleOverTime[1] = scale.length/2

      // set k to 4 because the first vec4 of rotationScaleOverTime is use for the length params
      // update i by 3 becase rotation is 3 numbers per vector, and k by 4 because rotationScaleOverTime is 4 numbers per vector
      let n = rotation.length
      for (let i = 0, k = 4; i < n; i += 3, k += 4) {
        this.rotationScaleOverTime[k] = degToRad(rotation[i]) // glsl rotationScaleOverTime[1..].x
        this.rotationScaleOverTime[k+1] = degToRad(rotation[i+1]) // glsl rotationScaleOverTime[1..].y
        this.rotationScaleOverTime[k+2] = degToRad(rotation[i+2]) // glsl rotationScaleOverTime[1..].z
      }

      n = scale.length
      for (let i = 0, k = 4; i < n; i++, k += 4) {
        this.rotationScaleOverTime[k+3] = scale[i] // glsl rotationScaleOverTime[1..].w
      }
    },

    updateVec4XYZRange(vecData, uniformAttr) {
      const vecRange = parseVecRange(vecData, [0,0,0])
      for (let i = 0, j = 0; i < vecRange.length; ) {
        this[uniformAttr][j++] = vecRange[i++] // x
        this[uniformAttr][j++] = vecRange[i++] // y
        this[uniformAttr][j++] = vecRange[i++] // z
        j++ // skip the w
      }
    },

    updateAngularVec4XYZRange(vecData, uniformAttr) {
      const vecRange = parseVecRange(vecData, [0,0,0])
      for (let i = 0, j = 0; i < vecRange.length; ) {
        this[uniformAttr][j++] = degToRad(vecRange[i++]) // x
        this[uniformAttr][j++] = degToRad(vecRange[i++]) // y
        this[uniformAttr][j++] = degToRad(vecRange[i++]) // z
        j++ // skip the w
      }
    },

    // update just the w component
    updateVec4WRange(floatData, def, uniformAttr) {
      let floatRange = parseVecRange(floatData, def)
      this[uniformAttr][3] = floatRange[0] // floatData value is packed into the 4th part of each vec4
      this[uniformAttr][7] = floatRange[1]

      return floatRange
    },

    updateAttributes() {
      if (this.geometry) {
        const n = this.count
        this.geometry.maxInstancedCount = n

        let instanceIDs = new Float32Array(n)
        for (let i = 0; i  < n; i++) {
          instanceIDs[i] = i
        }

        this.geometry.addAttribute("instanceID", new THREE.InstancedBufferAttribute(instanceIDs, 1)) // gl_InstanceID is not supported, so make our own id

        if (this.relative === "world") {
          this.geometry.addAttribute("instancePosition", new THREE.InstancedBufferAttribute(new Float32Array(3*n).fill(0), 3))
          this.geometry.addAttribute("instanceQuaternion", new THREE.InstancedBufferAttribute(new Float32Array(4*n).fill(0), 4))
        }
      }
    },

    updateWorldTransform: (function() {
      let position = new THREE.Vector3()
      let quaternion = new THREE.Quaternion()
      let scale = new THREE.Vector3()

      return function(emitterTime) {
        const data = this.data

        // for world relative particle the CPU sets the instancePosition and instanceQuaternion
        // of the new particles to the current object3D position/orientation, and tells the GPU
        // the ID of last emitted particle (this.params[WORLD_RELATIVE_ID_PARAM])
        if (this.geometry && this.relative === "world") {
          const spawnRate = this.data.spawnRate
          const isBurst = data.spawnType === "burst"
          const spawnDelta = isBurst ? 0 : 1/spawnRate // for burst particles spawn everything at once

          let instancePosition = this.geometry.getAttribute("instancePosition")
          let instanceQuaternion = this.geometry.getAttribute("instanceQuaternion")
          this.el.object3D.matrixWorld.decompose(position, quaternion, scale)

          let startID = this.nextID
          let numSpawned = 0
          let id = startID

          // the nextTime represents the startTime for each particle, so while the nextTime
          // is less than this frame's time, keep emitting particles. Note, if the spawnRate is
          // low, we may have to wait several frames before a particle is emitted, but if the 
          // spawnRate is high we will emit several particles per frame
          while (this.nextTime < emitterTime && numSpawned < this.count) {
            id = this.nextID
            instancePosition.setXYZ(id, position.x, position.y, position.z)
            instanceQuaternion.setXYZW(id, quaternion.x, quaternion.y, quaternion.z, quaternion.w)

            numSpawned++
            this.nextTime += spawnDelta
            this.nextID = (this.nextID + 1) % this.count // wrap around to 0 if we'd emitted the last particle in our stack
          }

          if (numSpawned > 0) {
            this.params[WORLD_RELATIVE_ID_PARAM] = id

            if (isBurst) { // if we did burst emit, then wait for maxAge before emitting again
              this.nextTime += this.lifeTime[1]
            }

            // if the buffer was wrapped, we cannot send just the end and beginning of a buffer, so submit everything
            if (this.nextID < startID) { 
              startID = 0
              numSpawned = this.count
            }
  
            instancePosition.updateRange.offset = startID
            instancePosition.updateRange.count = numSpawned
            instancePosition.needsUpdate = numSpawned > 0

            instanceQuaternion.updateRange.offset = startID
            instanceQuaternion.updateRange.count = numSpawned
            instanceQuaternion.needsUpdate = numSpawned > 0
          }
        }
      }
    })(),

    onBeforeCompile(shader) {
      shader.uniforms.params = { value: this.params }
      shader.uniforms.offset = { value: this.offset }
      shader.uniforms.velocity = { value: this.velocity }
      shader.uniforms.acceleration = { value: this.acceleration }
      shader.uniforms.angularVelocity = { value: this.angularVelocity }
      shader.uniforms.angularAcceleration = { value: this.angularAcceleration }
      shader.uniforms.colorOverTime = { value: this.colorOverTime }
      shader.uniforms.rotationScaleOverTime = { value: this.rotationScaleOverTime }

      // WARNING these shader replacements assume that the standard three.js shders are being used
      shader.vertexShader = shader.vertexShader.replace( "void main() {", `
        attribute float instanceID;

        #if defined(WORLD_RELATIVE)
        attribute vec3 instancePosition;
        attribute vec4 instanceQuaternion;
        #endif

        uniform vec4 params[3];
        uniform vec4 offset[2];
        uniform vec4 velocity[2];
        uniform vec4 acceleration[2];
        uniform vec4 angularVelocity[2];
        uniform vec4 angularAcceleration[2];
        uniform vec4 colorOverTime[OVER_TIME_ARRAY_LENGTH];
        uniform vec4 rotationScaleOverTime[OVER_TIME_ARRAY_LENGTH];

        varying vec4 vInstanceColor;

        // each call to random will produce a different result by varying randI
        float randI = 0.0;
        float random( const float seed )
        {
          randI += 0.001;
          return rand( vec2( seed, randI ));
        }

        vec3 randVec3Range( const vec3 range0, const vec3 range1, const float seed )
        {
          vec3 lerps = vec3( random( seed ), random( seed ), random( seed ) );
          return mix( range0, range1, lerps );
        }

        vec2 randVec2Range( const vec2 range0, const vec2 range1, const float seed )
        {
          vec2 lerps = vec2( random( seed ), random( seed ) );
          return mix( range0, range1, lerps );
        }

        float randFloatRange( const float range0, const float range1, const float seed )
        {
          float lerps = random( seed );
          return mix( range0, range1, lerps );
        }

        // theta.x is the angle in XY, theta.y is the angle in XZ
        vec3 radialToVec3( const float r, const vec2 theta )
        {
          vec2 cosTheta = cos(theta);
          vec2 sinTheta = sin(theta);
          float rc = r * cosTheta.x;
          float x = rc * cosTheta.y;
          float y = r * sinTheta.x;
          float z = rc * sinTheta.y;
          return vec3( x, y, z );
        }

        // array lengths are stored in the first slot, followed by actual values from slot 1 onwards
        // colors are packed min,max,min,max,min,max,...
        // color is packed in xyz and opacity in w, and they may have different length arrays

        vec4 calcColorOverTime( const float r, const float seed )
        {
          vec3 color = vec3(1.0);
          float opacity = 1.0;
          int colorN = int( colorOverTime[0].x );
          int opacityN = int( colorOverTime[0].y );
  
          if ( colorN == 1 )
          {
            color = randVec3Range( colorOverTime[1].xyz, colorOverTime[2].xyz, seed );
          }
          else if ( colorN > 1 )
          {
            float ck = r * ( float( colorN ) - 1.0 );
            float ci = floor( ck );
            int i = int( ci )*2 + 1;
            vec3 sColor = randVec3Range( colorOverTime[i].xyz, colorOverTime[i + 1].xyz, seed );
            vec3 eColor = randVec3Range( colorOverTime[i + 2].xyz, colorOverTime[i + 3].xyz, seed );
            color = mix( sColor, eColor, ck - ci );
          }

          if ( opacityN == 1 )
          {
            opacity = randFloatRange( colorOverTime[1].w, colorOverTime[2].w, seed );
          }
          else if ( opacityN > 1 )
          {
            float ok = r * ( float( opacityN ) - 1.0 );
            float oi = floor( ok );
            int j = int( oi )*2 + 1;
            float sOpacity = randFloatRange( colorOverTime[j].w, colorOverTime[j + 1].w, seed );
            float eOpacity = randFloatRange( colorOverTime[j + 2].w, colorOverTime[j + 3].w, seed );
            opacity = mix( sOpacity, eOpacity, ok - oi );
          }

          return vec4( color, opacity );
        }

        // as per calcColorOverTime but euler rotation is packed in xyz and scale in w

        vec4 calcRotationScaleOverTime( const float r, const float seed )
        {
          vec3 rotation = vec3(0.);
          float scale = 1.0;
          int rotationN = int( rotationScaleOverTime[0].x );
          int scaleN = int( rotationScaleOverTime[0].y );

          if ( rotationN == 1 )
          {
            rotation = randVec3Range( rotationScaleOverTime[1].xyz, rotationScaleOverTime[2].xyz, seed );
          }
          else if ( rotationN > 1 )
          {
            float rk = r * ( float( rotationN ) - 1.0 );
            float ri = floor( rk );
            int i = int( ri )*2 + 1; // *2 because each range is 2 vectors, and +1 because the first vector is for the length info
            vec3 sRotation = randVec3Range( rotationScaleOverTime[i].xyz, rotationScaleOverTime[i + 1].xyz, seed );
            vec3 eRotation = randVec3Range( rotationScaleOverTime[i + 2].xyz, rotationScaleOverTime[i + 3].xyz, seed );
            rotation = mix( sRotation, eRotation, rk - ri );
          }

          if ( scaleN == 1 )
          {
            scale = randFloatRange( rotationScaleOverTime[1].w, rotationScaleOverTime[2].w, seed );
          }
          else if ( scaleN > 1 )
          {
            float sk = r * ( float( scaleN ) - 1.0 );
            float si = floor( sk );
            int j = int( si )*2 + 1; // *2 because each range is 2 vectors, and +1 because the first vector is for the length info
            float sScale = randFloatRange( rotationScaleOverTime[j].w, rotationScaleOverTime[j + 1].w, seed );
            float eScale = randFloatRange( rotationScaleOverTime[j + 2].w, rotationScaleOverTime[j + 3].w, seed );
            scale = mix( sScale, eScale, sk - si );
          }

          return vec4( rotation, scale );
        }

        // assumes euler order is YXZ (standard convention for AFrame)
        vec4 eulerToQuaternion( const vec3 euler )
        {
          // from https://github.com/mrdoob/three.js/blob/master/src/math/Quaternion.js

          vec3 c = cos( euler * 0.5 );
          vec3 s = sin( euler * 0.5 );

          return vec4(
            s.x * c.y * c.z + c.x * s.y * s.z,
            c.x * s.y * c.z - s.x * c.y * s.z,
            c.x * c.y * s.z - s.x * s.y * c.z,
            c.x * c.y * c.z + s.x * s.y * s.z
          );
        }

        vec3 applyQuaternion( const vec3 v, const vec4 q )
        {
          return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
        }

        void main() {
          float time = params[0].x;
          float worldRelativeID = params[0].y;
          float radialType = params[0].z;
          float duration = params[0].w;
          float spawnType = params[1].x;
          float spawnRate = params[1].y;
          float baseSeed = params[1].z;
          float instanceCount = params[1].w;
          float maxAge = angularVelocity[1].w; // lifeTime packed into w component of angularVelocity

        #if defined(WORLD_RELATIVE)
          // current ID is set from the CPU so we can synchronize the instancePosition and instanceQuaternion correctly
          float ID0 = worldRelativeID; 
        #else
          float ID0 = floor( mod( time, maxAge ) * spawnRate ); // this will lose precision eventually
        #endif

          // particles are either emitted in a burst (spawnType == 0) or spread evenly
          // throughout 0..maxAge.  We calculate the ID of the last spawned particle ID0 
          // for this frame, any instance IDs after ID0 are assumed to belong to the previous loop

          float loop = floor( time / maxAge ) - spawnType * (instanceID > ID0 ? 1.0 : 0.0);
          float startTime = loop * maxAge + instanceID / spawnRate * spawnType;
          float age = startTime >= 0.0 ? time - startTime : -1.0; // if age is -1 we won't show the particle

          // we use the id as a seed for the randomizer, but because the IDs are fixed in 
          // the range 0..instanceCount we calculate a virtual ID by taking into account
          // the number of loops that have occurred (note, instanceIDs above ID0 are assumed 
          // to be in the previous loop).  We use the modoulo of the RANDOM_REPEAT_COUNT to
          // ensure that the virtualID doesn't exceed the floating point precision

          float virtualID = mod( instanceID + loop * instanceCount, float( RANDOM_REPEAT_COUNT ) );
          float seed = mod(1664525.*virtualID*(baseSeed*11.) + 1013904223., 4294967296.)/4294967296.; // we don't have enough precision in 32-bit float, but results look ok

          float lifeTime = randFloatRange( angularVelocity[0].w, maxAge, seed ); 

          // don't show particles that would be emitted after the duration
          if ( duration > 0.0 && time - age >= duration ) 
          {
            age = -1.0;
          }
          else
          {
            float direction = params[2].z; // 0 is forward, 1 is backward

            age = age + direction * ( maxAge - 2.0 * age );
          }

          // the ageRatio will be used for the lerps on over-time attributes
          float ageRatio = age/lifeTime;
      `)

      shader.vertexShader = shader.vertexShader.replace( "#include <begin_vertex>", `
        vec3 transformed = vec3(0.0);
        vInstanceColor = vec4(1.0);

        if ( ageRatio >= 0.0 && ageRatio <= 1.0 ) 
        {
          vec2 radialDir = vec2( 1.0, radialType );

          vec2 ANGLE_RANGE[2];
          ANGLE_RANGE[0] = vec2( 0.0, 0.0 ) * radialDir;
          ANGLE_RANGE[1] = vec2( 2.0*PI, 2.0*PI ) * radialDir;

          float ri = 1.0;
          vec3 p = randVec3Range( offset[0].xyz, offset[1].xyz, seed );
          vec3 v = randVec3Range( velocity[0].xyz, velocity[1].xyz, seed );
          vec3 a = randVec3Range( acceleration[0].xyz, acceleration[1].xyz, seed );

          vec2 theta = randVec2Range( ANGLE_RANGE[0], ANGLE_RANGE[1], seed );

          float pr = randFloatRange( offset[0].w, offset[1].w, seed );
          vec3 p2 = radialToVec3( pr, theta );

          float vr = randFloatRange( velocity[0].w, velocity[1].w, seed );
          vec3 v2 = radialToVec3( vr, theta );

          float ar = randFloatRange( acceleration[0].w, acceleration[1].w, seed );
          vec3 a2 = radialToVec3( ar, theta );

          vec4 rotScale = calcRotationScaleOverTime( ageRatio, seed );
          vec4 rotationQuaternion = eulerToQuaternion( rotScale.xyz );

          vec3 va = randVec3Range( angularVelocity[0].xyz, angularVelocity[1].xyz, seed );
          vec3 aa = randVec3Range( angularAcceleration[0].xyz, angularAcceleration[1].xyz, seed );

          vec3 rotationalVelocity = ( va + aa*age );
          vec4 angularQuaternion = eulerToQuaternion( rotationalVelocity * age );

          transformed = rotScale.w * position.xyz;
          transformed = applyQuaternion( transformed, rotationQuaternion );

          vec3 velocity = ( v + v2 + ( a + a2 )*age );

          transformed += applyQuaternion( p + p2 + velocity * age, angularQuaternion );

        #if defined(WORLD_RELATIVE)
        
          transformed += 2.0 * cross( instanceQuaternion.xyz, cross( instanceQuaternion.xyz, transformed ) + instanceQuaternion.w * transformed );
          transformed += instancePosition;

        #endif

          vInstanceColor = calcColorOverTime( ageRatio, seed ); // rgba format
        }
      `)

      shader.fragmentShader = shader.fragmentShader.replace( "void main() {", `
        varying vec4 vInstanceColor;

        void main() {
      `)

      shader.fragmentShader = shader.fragmentShader.replace( "#include <color_fragment>", `
      #ifdef USE_COLOR
        diffuseColor.rgb *= vColor;
      #endif

        diffuseColor *= vInstanceColor;
      `)

      this.shader = shader
    },
  })

})()


/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tfc from '@tensorflow/tfjs-converter';
import * as tf from '@tensorflow/tfjs-core';

import {MILLISECOND_TO_MICRO_SECONDS, SECOND_TO_MICRO_SECONDS} from '../calculators/constants';
import {getImageSize, toImageTensor} from '../calculators/image_utils';
import {ImageSize} from '../calculators/interfaces/common_interfaces';
import {BoundingBox} from '../calculators/interfaces/shape_interfaces';
import {isVideo} from '../calculators/is_video';
import {KeypointsOneEuroFilter} from '../calculators/keypoints_one_euro_filter';
import {LowPassFilter} from '../calculators/low_pass_filter';
import {COCO_KEYPOINTS} from '../constants';
import {PoseDetector} from '../pose_detector';
import {InputResolution, Keypoint, Pose, PoseDetectorInput, SupportedModels} from '../types';
import {getKeypointIndexByName} from '../util';

import {CROP_FILTER_ALPHA, KEYPOINT_FILTER_CONFIG, MIN_CROP_KEYPOINT_SCORE, MOVENET_CONFIG, MOVENET_MULTIPOSE_RESOLUTION, MOVENET_SINGLE_POSE_ESTIMATION_CONFIG, MOVENET_SINGLEPOSE_LIGHTNING_RESOLUTION, MOVENET_SINGLEPOSE_LIGHTNING_URL, MOVENET_SINGLEPOSE_THUNDER_RESOLUTION, MOVENET_SINGLEPOSE_THUNDER_URL, MULTIPOSE, SINGLEPOSE_LIGHTNING, SINGLEPOSE_THUNDER} from './constants';
import {validateEstimationConfig, validateModelConfig} from './detector_utils';
import {MoveNetEstimationConfig, MoveNetModelConfig} from './types';

/**
 * MoveNet detector class.
 */
class MoveNetDetector implements PoseDetector {
  private readonly modelInputResolution:
      InputResolution = {height: 0, width: 0};
  private readonly keypointIndexByName =
      getKeypointIndexByName(SupportedModels.MoveNet);
  private readonly multiPoseModel: boolean;
  private readonly enableSmoothing: boolean;

  // Global states.
  private readonly keypointsFilter =
      new KeypointsOneEuroFilter(KEYPOINT_FILTER_CONFIG);
  private readonly cropRegionFilterYMin = new LowPassFilter(CROP_FILTER_ALPHA);
  private readonly cropRegionFilterXMin = new LowPassFilter(CROP_FILTER_ALPHA);
  private readonly cropRegionFilterYMax = new LowPassFilter(CROP_FILTER_ALPHA);
  private readonly cropRegionFilterXMax = new LowPassFilter(CROP_FILTER_ALPHA);
  private cropRegion: BoundingBox;

  constructor(
      private readonly moveNetModel: tfc.GraphModel,
      config: MoveNetModelConfig) {
    // Only single-pose models have a fixed input resolution.
    if (config.modelType === SINGLEPOSE_LIGHTNING) {
      this.modelInputResolution.width = MOVENET_SINGLEPOSE_LIGHTNING_RESOLUTION;
      this.modelInputResolution.height =
          MOVENET_SINGLEPOSE_LIGHTNING_RESOLUTION;
    } else if (config.modelType === SINGLEPOSE_THUNDER) {
      this.modelInputResolution.width = MOVENET_SINGLEPOSE_THUNDER_RESOLUTION;
      this.modelInputResolution.height = MOVENET_SINGLEPOSE_THUNDER_RESOLUTION;
    }
    this.multiPoseModel = config.modelType === MULTIPOSE;
    this.enableSmoothing = config.enableSmoothing;
  }

  /**
   * Runs inference on an image using a model that is assumed to be a single
   * person keypoint model that outputs 17 keypoints.
   * @param inputImage 4D tensor containing the input image. Should be of size
   *     [1, modelHeight, modelWidth, 3].
   * @return An array of `Keypoint`s, or null if the inference call could not be
   *     executed (for example when the model was not initialized yet) or if it
   *     produced an unexpected tensor size.
   */
  async detectSinglePersonKeypoints(inputImage: tf.Tensor4D):
      Promise<Keypoint[]|null> {
    if (!this.moveNetModel) {
      return null;
    }

    const outputTensor = this.moveNetModel.execute(inputImage) as tf.Tensor;

    if (!outputTensor) {
      return null;
    }

    // We expect an output tensor of shape [1, 1, 17, 3] (batch, person,
    // keypoint, (y, x, score)).
    const numKeypoints = 17;
    if (outputTensor.shape.length !== 4 || outputTensor.shape[0] !== 1 ||
        outputTensor.shape[1] !== 1 || outputTensor.shape[2] !== numKeypoints ||
        outputTensor.shape[3] !== 3) {
      outputTensor.dispose();
      return null;
    }

    // Only use asynchronous downloads when we really have to (WebGPU) because
    // that will poll for download completion using setTimeOut which introduces
    // extra latency.
    let inferenceResult;
    if (tf.getBackend() !== 'webgpu') {
      inferenceResult = outputTensor.dataSync();
    } else {
      inferenceResult = await outputTensor.data();
    }
    outputTensor.dispose();

    const keypoints: Keypoint[] = [];
    for (let i = 0; i < numKeypoints; ++i) {
      keypoints[i] = {
        y: inferenceResult[i * 3],
        x: inferenceResult[i * 3 + 1],
        score: inferenceResult[i * 3 + 2]
      };
    }

    return keypoints;
  }

  /**
   * Runs inference on an image using a model that is assumed to be a
   * multi-person keypoint model that outputs 17 keypoints and a box for a
   * multiple persons.
   * @param inputImage 4D tensor containing the input image. Should be of size
   *     [1, width, height, 3], where width and height are divisible by 32.
   * @return An array of an array of `Keypoint`s, or null if the inference call
   *     could not be executed (for example when the model was not initialized
   *     yet) or if it produced an unexpected tensor size.
   */
  async detectMultiPersonKeypoints(inputImage: tf.Tensor4D):
      Promise<Keypoint[][]|null> {
    if (!this.moveNetModel) {
      return null;
    }

    const outputTensor = this.moveNetModel.execute(inputImage) as tf.Tensor;

    if (!outputTensor) {
      return null;
    }

    // Multi-pose model output is a [1, n, 56] tensor ([batch, num_instances,
    // instance_keypoints_and_box]).
    const numKeypoints = 17;
    const boundingBoxSize = 5;  // ymin, xmin, ymax, xmax, score
    const multiPoseInstanceSize = numKeypoints * 3 + boundingBoxSize;
    if (outputTensor.shape.length !== 3 || outputTensor.shape[0] !== 1 ||
        outputTensor.shape[2] !== multiPoseInstanceSize) {
      outputTensor.dispose();
      return null;
    }

    // Only use asynchronous downloads when we really have to (WebGPU) because
    // that will poll for download completion using setTimeOut which introduces
    // extra latency.
    let inferenceResult;
    if (tf.getBackend() !== 'webgpu') {
      inferenceResult = outputTensor.dataSync();
    } else {
      inferenceResult = await outputTensor.data();
    }
    outputTensor.dispose();

    const keypoints: Keypoint[][] = [];

    const numInstances = inferenceResult.length / multiPoseInstanceSize;
    for (let i = 0; i < numInstances; ++i) {
      keypoints[i] = [];
      for (let j = 0; j < numKeypoints; ++j) {
        keypoints[i][j] = {
          y: inferenceResult[i * multiPoseInstanceSize + j * 3],
          x: inferenceResult[i * multiPoseInstanceSize + j * 3 + 1],
          score: inferenceResult[i * multiPoseInstanceSize + j * 3 + 2]
        };
      }
    }

    return keypoints;
  }

  /**
   * Estimates poses for an image or video frame.
   *
   * This does standard ImageNet pre-processing before inferring through the
   * model. The image should pixels should have values [0-255]. It returns an
   * array of poses.
   *
   * @param image ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement
   * The input image to feed through the network.
   *
   * @param config Optional. A configuration object with the following
   * properties:
   *  `maxPoses`: Optional. Has to be set to 1.
   *
   * @param timestamp Optional. In milliseconds. This is useful when image is
   *     a tensor, which doesn't have timestamp info. Or to override timestamp
   *     in a video.
   *
   * @return An array of `Pose`s.
   */
  async estimatePoses(
      image: PoseDetectorInput,
      estimationConfig:
          MoveNetEstimationConfig = MOVENET_SINGLE_POSE_ESTIMATION_CONFIG,
      timestamp?: number): Promise<Pose[]> {
    estimationConfig = validateEstimationConfig(estimationConfig);

    if (image == null) {
      this.reset();
      return [];
    }

    if (timestamp == null) {
      if (isVideo(image)) {
        timestamp = image.currentTime * SECOND_TO_MICRO_SECONDS;
      }
    } else {
      timestamp = timestamp * MILLISECOND_TO_MICRO_SECONDS;
    }

    const imageTensor3D = toImageTensor(image);
    const imageSize = getImageSize(imageTensor3D);
    const imageTensor4D: tf.Tensor4D = tf.expandDims(imageTensor3D, 0);

    // Make sure we don't dispose the input image if it's already a tensor.
    if (!(image instanceof tf.Tensor)) {
      imageTensor3D.dispose();
    }

    let keypoints: Keypoint[][] = [];
    if (!this.multiPoseModel) {
      keypoints =
          [await this.estimateSinglePose(imageTensor4D, imageSize, timestamp)];
    } else {
      keypoints = await this.estimateMultiplePoses(imageTensor4D, imageSize);
    }

    if (!keypoints) {
      return [];
    }

    // Convert keypoint coordinates from normalized coordinates to image space,
    // add keypoint names and calculate the overall pose score.
    const poseScores: number[] = [];
    for (let i = 0; i < keypoints.length; ++i) {
      let numValidKeypoints = 0.0;
      poseScores[i] = 0.0;
      for (let j = 0; j < keypoints[i].length; ++j) {
        keypoints[i][j].name = COCO_KEYPOINTS[j];
        keypoints[i][j].y *= imageSize.height;
        keypoints[i][j].x *= imageSize.width;
        if (keypoints[i][j].score > MIN_CROP_KEYPOINT_SCORE) {
          ++numValidKeypoints;
          poseScores[i] += keypoints[i][j].score;
        }
      }

      if (numValidKeypoints > 0) {
        poseScores[i] /= numValidKeypoints;
      } else if (!this.multiPoseModel) {
        // No pose detected, so reset all filters.
        this.resetFilters();
      }
    }

    const poses: Pose[] = [];
    for (let i = 0; i < keypoints.length; ++i) {
      poses[i] = {score: poseScores[i], keypoints: keypoints[i]};
    }

    return poses;
  }

  /**
   * Runs a single-person keypoint model on an image, including the image
   * cropping and keypoint filtering logic.
   *
   * @param imageTensor4D A tf.Tensor4D that contains the input image.
   *
   * @param imageSize: The width and height of the input image.
   *
   * @param timestamp Image timestamp in milliseconds.
   *
   * @return An array of `Keypoint` or null.
   */
  async estimateSinglePose(
      imageTensor4D: tf.Tensor4D, imageSize: ImageSize,
      timestamp: number): Promise<Keypoint[]|null> {
    if (!this.cropRegion) {
      this.cropRegion = this.initCropRegion(imageSize.width, imageSize.height);
    }

    const croppedImage = tf.tidy(() => {
      // Crop region is a [batch, 4] size tensor.
      const cropRegionTensor = tf.tensor2d([[
        this.cropRegion.yMin, this.cropRegion.xMin, this.cropRegion.yMax,
        this.cropRegion.xMax
      ]]);
      // The batch index that the crop should operate on. A [batch] size
      // tensor.
      const boxInd: tf.Tensor1D = tf.zeros([1], 'int32');
      // Target size of each crop.
      const cropSize: [number, number] =
          [this.modelInputResolution.height, this.modelInputResolution.width];
      return tf.cast(
          tf.image.cropAndResize(
              imageTensor4D, cropRegionTensor, boxInd, cropSize, 'bilinear', 0),
          'int32');
    });
    imageTensor4D.dispose();

    let keypoints = await this.detectSinglePersonKeypoints(croppedImage);
    croppedImage.dispose();

    if (keypoints == null) {
      this.reset();
      return [];
    }

    // Convert keypoints from crop coordinates to image coordinates.
    for (let i = 0; i < keypoints.length; ++i) {
      keypoints[i].y =
          this.cropRegion.yMin + keypoints[i].y * this.cropRegion.height;
      keypoints[i].x =
          this.cropRegion.xMin + keypoints[i].x * this.cropRegion.width;
    }

    // Apply the sequential filter before estimating the cropping area to make
    // it more stable.
    if (timestamp != null && this.enableSmoothing) {
      keypoints =
          this.keypointsFilter.apply(keypoints, timestamp, 1 /* objectScale */);
    }

    // Determine next crop region based on detected keypoints and if a crop
    // region is not detected, this will trigger the model to run on the full
    // image the next time estimatePoses() is called.
    const newCropRegion =
        this.determineCropRegion(keypoints, imageSize.height, imageSize.width);

    this.cropRegion = this.filterCropRegion(newCropRegion);

    return keypoints;
  }

  /**
   * Runs a multi-person keypoint model on an image, including input image
   * padding.
   *
   * @param imageTensor4D A tf.Tensor4D that contains the input image.
   *
   * @param imageSize: The width and height of the input image.
   *
   * @return An array of `Keypoint` or null.
   */
  async estimateMultiplePoses(imageTensor4D: tf.Tensor4D, imageSize: ImageSize):
      Promise<Keypoint[][]|null> {
    let resizedImage: tf.Tensor4D;
    let resizedWidth: number;
    let resizedHeight: number;
    let paddedImage: tf.Tensor4D;
    let paddedWidth: number;
    let paddedHeight: number;
    const dimensionDivisor = 32;  // Dimensions need to be divisible by 32.
    if (imageSize.width > imageSize.height) {
      resizedWidth = MOVENET_MULTIPOSE_RESOLUTION;
      resizedHeight =
          MOVENET_MULTIPOSE_RESOLUTION * imageSize.height / imageSize.width;
      resizedImage =
          tf.image.resizeBilinear(imageTensor4D, [resizedHeight, resizedWidth]);

      paddedWidth = resizedWidth;
      paddedHeight =
          Math.ceil(resizedHeight / dimensionDivisor) * dimensionDivisor;
      paddedImage = tf.pad(
          resizedImage,
          [[0, 0], [0, paddedHeight - resizedHeight], [0, 0], [0, 0]]);
    } else {
      resizedWidth =
          MOVENET_MULTIPOSE_RESOLUTION * imageSize.width / imageSize.height;
      resizedHeight = MOVENET_MULTIPOSE_RESOLUTION;
      resizedImage =
          tf.image.resizeBilinear(imageTensor4D, [resizedHeight, resizedWidth]);

      paddedWidth =
          Math.ceil(resizedWidth / dimensionDivisor) * dimensionDivisor;
      paddedHeight = resizedHeight;
      paddedImage = tf.pad(
          resizedImage,
          [[0, 0], [0, 0], [0, paddedWidth - resizedWidth], [0, 0]]);
    }
    resizedImage.dispose();
    imageTensor4D.dispose();

    const paddedImageInt32 = tf.cast(paddedImage, 'int32');
    paddedImage.dispose();
    const keypoints = await this.detectMultiPersonKeypoints(paddedImageInt32);
    paddedImageInt32.dispose();

    if (keypoints == null) {
      return [];
    }

    // Convert keypoints from padded coordinates to image coordinates.
    for (let i = 0; i < keypoints.length; ++i) {
      for (let j = 0; j < keypoints[i].length; ++j) {
        keypoints[i][j].y = keypoints[i][j].y * paddedHeight / resizedHeight;
        keypoints[i][j].x = keypoints[i][j].x * paddedWidth / resizedWidth;
      }
    }

    return keypoints;
  }

  filterCropRegion(newCropRegion: BoundingBox): BoundingBox {
    if (!newCropRegion) {
      this.cropRegionFilterYMin.reset();
      this.cropRegionFilterXMin.reset();
      this.cropRegionFilterYMax.reset();
      this.cropRegionFilterXMax.reset();
      return null;
    } else {
      const filteredYMin = this.cropRegionFilterYMin.apply(newCropRegion.yMin);
      const filteredXMin = this.cropRegionFilterXMin.apply(newCropRegion.xMin);
      const filteredYMax = this.cropRegionFilterYMax.apply(newCropRegion.yMax);
      const filteredXMax = this.cropRegionFilterXMax.apply(newCropRegion.xMax);
      return {
        yMin: filteredYMin,
        xMin: filteredXMin,
        yMax: filteredYMax,
        xMax: filteredXMax,
        height: filteredYMax - filteredYMin,
        width: filteredXMax - filteredXMin
      };
    }
  }

  dispose() {
    this.moveNetModel.dispose();
  }

  reset() {
    this.cropRegion = null;
    this.resetFilters();
  }

  resetFilters() {
    this.keypointsFilter.reset();
    this.cropRegionFilterYMin.reset();
    this.cropRegionFilterXMin.reset();
    this.cropRegionFilterYMax.reset();
    this.cropRegionFilterXMax.reset();
  }

  torsoVisible(keypoints: Keypoint[]): boolean {
    return (
        (keypoints[this.keypointIndexByName['left_hip']].score >
             MIN_CROP_KEYPOINT_SCORE ||
         keypoints[this.keypointIndexByName['right_hip']].score >
             MIN_CROP_KEYPOINT_SCORE) &&
        (keypoints[this.keypointIndexByName['left_shoulder']].score >
             MIN_CROP_KEYPOINT_SCORE ||
         keypoints[this.keypointIndexByName['right_shoulder']].score >
             MIN_CROP_KEYPOINT_SCORE));
  }

  /**
   * Calculates the maximum distance from each keypoints to the center location.
   * The function returns the maximum distances from the two sets of keypoints:
   * full 17 keypoints and 4 torso keypoints. The returned information will be
   * used to determine the crop size. See determineCropRegion for more detail.
   *
   * @param targetKeypoints Maps from joint names to coordinates.
   */
  determineTorsoAndBodyRange(
      keypoints: Keypoint[], targetKeypoints: {[index: string]: number[]},
      centerY: number, centerX: number): number[] {
    const torsoJoints =
        ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];
    let maxTorsoYrange = 0.0;
    let maxTorsoXrange = 0.0;
    for (let i = 0; i < torsoJoints.length; i++) {
      const distY = Math.abs(centerY - targetKeypoints[torsoJoints[i]][0]);
      const distX = Math.abs(centerX - targetKeypoints[torsoJoints[i]][1]);
      if (distY > maxTorsoYrange) {
        maxTorsoYrange = distY;
      }
      if (distX > maxTorsoXrange) {
        maxTorsoXrange = distX;
      }
    }
    let maxBodyYrange = 0.0;
    let maxBodyXrange = 0.0;
    for (const key of Object.keys(targetKeypoints)) {
      if (keypoints[this.keypointIndexByName[key]].score <
          MIN_CROP_KEYPOINT_SCORE) {
        continue;
      }
      const distY = Math.abs(centerY - targetKeypoints[key][0]);
      const distX = Math.abs(centerX - targetKeypoints[key][1]);
      if (distY > maxBodyYrange) {
        maxBodyYrange = distY;
      }
      if (distX > maxBodyXrange) {
        maxBodyXrange = distX;
      }
    }

    return [maxTorsoYrange, maxTorsoXrange, maxBodyYrange, maxBodyXrange];
  }

  /**
   * Determines the region to crop the image for the model to run inference on.
   * The algorithm uses the detected joints from the previous frame to estimate
   * the square region that encloses the full body of the target person and
   * centers at the midpoint of two hip joints. The crop size is determined by
   * the distances between each joints and the center point.
   * When the model is not confident with the four torso joint predictions, the
   * function returns a default crop which is the full image padded to square.
   */
  determineCropRegion(
      keypoints: Keypoint[], imageHeight: number,
      imageWidth: number): BoundingBox {
    const targetKeypoints: {[index: string]: number[]} = {};

    for (const key of COCO_KEYPOINTS) {
      targetKeypoints[key] = [
        keypoints[this.keypointIndexByName[key]].y * imageHeight,
        keypoints[this.keypointIndexByName[key]].x * imageWidth
      ];
    }

    if (this.torsoVisible(keypoints)) {
      const centerY =
          (targetKeypoints['left_hip'][0] + targetKeypoints['right_hip'][0]) /
          2;
      const centerX =
          (targetKeypoints['left_hip'][1] + targetKeypoints['right_hip'][1]) /
          2;

      const [maxTorsoYrange, maxTorsoXrange, maxBodyYrange, maxBodyXrange] =
          this.determineTorsoAndBodyRange(
              keypoints, targetKeypoints, centerY, centerX);

      let cropLengthHalf = Math.max(
          maxTorsoXrange * 1.9, maxTorsoYrange * 1.9, maxBodyYrange * 1.2,
          maxBodyXrange * 1.2);

      cropLengthHalf = Math.min(
          cropLengthHalf,
          Math.max(
              centerX, imageWidth - centerX, centerY, imageHeight - centerY));

      const cropCorner = [centerY - cropLengthHalf, centerX - cropLengthHalf];

      if (cropLengthHalf > Math.max(imageWidth, imageHeight) / 2) {
        return this.initCropRegion(imageHeight, imageWidth);
      } else {
        const cropLength = cropLengthHalf * 2;
        return {
          yMin: cropCorner[0] / imageHeight,
          xMin: cropCorner[1] / imageWidth,
          yMax: (cropCorner[0] + cropLength) / imageHeight,
          xMax: (cropCorner[1] + cropLength) / imageWidth,
          height: (cropCorner[0] + cropLength) / imageHeight -
              cropCorner[0] / imageHeight,
          width: (cropCorner[1] + cropLength) / imageWidth -
              cropCorner[1] / imageWidth
        };
      }
    } else {
      return this.initCropRegion(imageHeight, imageWidth);
    }
  }

  /**
   * Provides initial crop region.
   *
   * The function provides the initial crop region when the algorithm cannot
   * reliably determine the crop region from the previous frame. There are two
   * scenarios:
   *   1) The very first frame: the function returns the best quess by cropping
   *      a square in the middle of the image.
   *   2) Not enough reliable keypoints detected from the previous frame: the
   *      function pads the full image from both sides to make it a square
   *      image.
   */
  private initCropRegion(imageHeight: number, imageWidth: number) {
    let boxHeight: number, boxWidth: number, yMin: number, xMin: number;
    if (!this.cropRegion) {
      // If it is the first frame, perform a best guess by making the square
      // crop at the image center to better utilize the image pixels and
      // create higher chance to enter the cropping loop.
      if (imageWidth > imageHeight) {
        boxHeight = 1.0;
        boxWidth = imageHeight / imageWidth;
        yMin = 0.0;
        xMin = (imageWidth / 2 - imageHeight / 2) / imageWidth;
      } else {
        boxHeight = imageWidth / imageHeight;
        boxWidth = 1.0;
        yMin = (imageHeight / 2 - imageWidth / 2) / imageHeight;
        xMin = 0.0;
      }
    } else {
      // No cropRegion was available from a previous estimatePoses() call, so
      // run the model on the full image with padding on both sides.
      if (imageWidth > imageHeight) {
        boxHeight = imageWidth / imageHeight;
        boxWidth = 1.0;
        yMin = (imageHeight / 2 - imageWidth / 2) / imageHeight;
        xMin = 0.0;
      } else {
        boxHeight = 1.0;
        boxWidth = imageHeight / imageWidth;
        yMin = 0.0;
        xMin = (imageWidth / 2 - imageHeight / 2) / imageWidth;
      }
    }
    return {
      yMin,
      xMin,
      yMax: yMin + boxHeight,
      xMax: xMin + boxWidth,
      height: boxHeight,
      width: boxWidth
    };
  }
}

/**
 * Loads the MoveNet model instance from a checkpoint. The model to be loaded
 * is configurable using the config dictionary `ModelConfig`. Please find more
 * details in the documentation of the `ModelConfig`.
 *
 * @param config `ModelConfig` dictionary that contains parameters for
 * the MoveNet loading process. Please find more details of each parameter
 * in the documentation of the `ModelConfig` interface.
 */
export async function load(modelConfig: MoveNetModelConfig = MOVENET_CONFIG):
    Promise<PoseDetector> {
  const config = validateModelConfig(modelConfig);
  let model: tfc.GraphModel;
  if (config.modelUrl) {
    model = await tfc.loadGraphModel(config.modelUrl);
  } else {
    let modelUrl;
    if (config.modelType === SINGLEPOSE_LIGHTNING) {
      modelUrl = MOVENET_SINGLEPOSE_LIGHTNING_URL;
    } else if (config.modelType === SINGLEPOSE_THUNDER) {
      modelUrl = MOVENET_SINGLEPOSE_THUNDER_URL;
    } else {
      throw new Error(`MoveNet multi-pose can only be loaded from a URL, ' +
        'not from TF.Hub yet.`);
    }
    model = await tfc.loadGraphModel(modelUrl, {fromTFHub: true});
  }
  return new MoveNetDetector(model, config);
}

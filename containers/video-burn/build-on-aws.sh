#!/bin/bash
# =============================================================================
# Build the video-burn image on AWS CodeBuild (linux/arm64) and push it to ECR
# as :latest and :<commit>. No Docker needed on this machine.
#
# Zips the committed HEAD (only the paths the Dockerfile copies), uploads it to
# s3://padmakara-pt-app/codebuild/video-burn-build.zip, starts the
# padmakara-video-burn-build project and waits for the result.
#
# Usage (from anywhere in the repo, with AWS credentials for the account):
#   AWS_PROFILE=padmakara ./containers/video-burn/build-on-aws.sh
# =============================================================================
set -euo pipefail

REGION="eu-west-3"
PROJECT="padmakara-video-burn-build"
SOURCE_URI="s3://padmakara-pt-app/codebuild/video-burn-build.zip"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ -n "$(git status --porcelain -- containers/video-burn src/lib/slides)" ]; then
    echo "ERROR: uncommitted changes in containers/video-burn or src/lib/slides." >&2
    echo "The build uses the committed HEAD; commit first." >&2
    exit 1
fi

COMMIT="$(git rev-parse --short=12 HEAD)"
ZIP="$(mktemp -d)/video-burn-build.zip"

echo "[1/3] Packaging $COMMIT..."
git archive --format=zip -o "$ZIP" HEAD containers/video-burn src/lib/slides

echo "[2/3] Uploading the source..."
aws s3 cp "$ZIP" "$SOURCE_URI" --region "$REGION" --only-show-errors
rm -f "$ZIP"

echo "[3/3] Starting the build..."
BUILD_ID="$(aws codebuild start-build --project-name "$PROJECT" --region "$REGION" \
    --environment-variables-override "name=IMAGE_TAG,value=$COMMIT,type=PLAINTEXT" \
    --query build.id --output text)"
echo "Build $BUILD_ID"

while true; do
    STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
        --query 'builds[0].buildStatus' --output text)"
    [ "$STATUS" != "IN_PROGRESS" ] && break
    sleep 20
done

echo "Status: $STATUS"
echo "Logs: https://$REGION.console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT/history"
[ "$STATUS" = "SUCCEEDED" ]

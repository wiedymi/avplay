import React from "react";
import type { FileInfo } from "@avplay/react";

interface TrackListProps {
	fileInfo: FileInfo | null;
	onVideoTrackSelect: (index: number) => void;
	onAudioTrackSelect: (index: number) => void;
	onSubtitleTrackSelect: (index: number) => void;
	onExtractTrack: (
		trackType: "video" | "audio" | "subtitle",
		index: number,
	) => void;
	onDownloadAttachment: (index: number) => void;
}

export const TrackList: React.FC<TrackListProps> = ({
	fileInfo,
	onVideoTrackSelect,
	onAudioTrackSelect,
	onSubtitleTrackSelect,
	onExtractTrack,
	onDownloadAttachment,
}) => {
	if (!fileInfo) return null;

	return (
		<>
			{/* Video Tracks */}
			{fileInfo.trackCounts.video > 0 && (
				<>
					<div className="control-row">
						<label>VIDEO:</label>
						<select
							onChange={(e) => onVideoTrackSelect(parseInt(e.target.value))}
						>
							{fileInfo.videoTracks.map((track, index) => (
								<option key={index} value={index}>
									{track}
								</option>
							))}
						</select>
					</div>

					<div className="track-list">
						<h2>VIDEO TRACKS</h2>
						<div>
							{fileInfo.videoTracks.map((track, index) => (
								<div key={index} className="track-item">
									<div className="track-info">{track}</div>
									<button
										className="extract-btn"
										onClick={() => onExtractTrack("video", index)}
									>
										EXTRACT
									</button>
								</div>
							))}
						</div>
					</div>
				</>
			)}

			{/* Audio Tracks */}
			{fileInfo.trackCounts.audio > 0 && (
				<>
					<div className="control-row">
						<label>AUDIO:</label>
						<select
							onChange={(e) => onAudioTrackSelect(parseInt(e.target.value))}
						>
							{fileInfo.audioTracks.map((track, index) => (
								<option key={index} value={index}>
									{track}
								</option>
							))}
						</select>
					</div>

					<div className="track-list">
						<h2>AUDIO TRACKS</h2>
						<div>
							{fileInfo.audioTracks.map((track, index) => (
								<div key={index} className="track-item">
									<div className="track-info">{track}</div>
									<button
										className="extract-btn"
										onClick={() => onExtractTrack("audio", index)}
									>
										EXTRACT
									</button>
								</div>
							))}
						</div>
					</div>
				</>
			)}

			{/* Subtitle Tracks */}
			{fileInfo.trackCounts.subtitle > 0 && (
				<>
					<div className="control-row">
						<label>SUBTITLES:</label>
						<select
							onChange={(e) => onSubtitleTrackSelect(parseInt(e.target.value))}
						>
							{fileInfo.subtitleTracks.map((track, index) => (
								<option key={index} value={index}>
									{track}
								</option>
							))}
						</select>
					</div>

					<div className="track-list">
						<h2>SUBTITLE TRACKS</h2>
						<div>
							{fileInfo.subtitleTracks.map((track, index) => (
								<div key={index} className="track-item">
									<div className="track-info">{track}</div>
									<button
										className="extract-btn"
										onClick={() => onExtractTrack("subtitle", index)}
									>
										EXTRACT
									</button>
								</div>
							))}
						</div>
					</div>
				</>
			)}

			{/* Attachments */}
			{fileInfo.trackCounts.attachment > 0 && (
				<div className="attachment-list">
					<h2>ATTACHMENTS</h2>
					<div>
						{fileInfo.attachments.map((attachment, index) => (
							<div key={index} className="attachment-item">
								<div className="attachment-info">{attachment}</div>
								<button
									className="download-btn"
									onClick={() => onDownloadAttachment(index)}
								>
									DOWNLOAD
								</button>
							</div>
						))}
					</div>
				</div>
			)}
		</>
	);
};

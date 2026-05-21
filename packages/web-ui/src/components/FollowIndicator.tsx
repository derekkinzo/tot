interface Props {
  followMode: 'following' | 'paused';
  onToggle: () => void;
}

export default function FollowIndicator({ followMode, onToggle }: Props) {
  const isFollowing = followMode === 'following';

  return (
    <button
      onClick={onToggle}
      title={isFollowing ? 'Following agent (click or press F to pause)' : 'Paused (click or press F to follow)'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        border: isFollowing ? '1px solid #3fb950' : '1px solid #30363d',
        background: isFollowing ? 'rgba(63, 185, 80, 0.1)' : '#1c1f26',
        color: isFollowing ? '#3fb950' : '#8b949e',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
      }}
    >
      <span
        className={isFollowing ? 'follow-dot' : ''}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isFollowing ? '#3fb950' : '#6b7280',
          display: 'inline-block',
        }}
      />
      <span>{isFollowing ? 'Following' : 'Follow'}</span>
      <span style={{ color: '#6b7280', fontSize: 10, marginLeft: 2 }}>F</span>
    </button>
  );
}

import { useEffect, useRef } from 'react';

export function CursorAnimation() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cursorRef.current || !trailRef.current) return;

    // Define a path that mimics cursor movement in a PDF editor
    // This creates a smooth, organic path that looks like someone editing a document
    const path = [
      { x: 15, y: 20 },
      { x: 25, y: 25 },
      { x: 35, y: 30 },
      { x: 45, y: 28 },
      { x: 55, y: 32 },
      { x: 65, y: 35 },
      { x: 70, y: 40 },
      { x: 75, y: 45 },
      { x: 80, y: 50 },
      { x: 75, y: 55 },
      { x: 70, y: 60 },
      { x: 65, y: 65 },
      { x: 60, y: 70 },
      { x: 55, y: 75 },
      { x: 50, y: 80 },
      { x: 45, y: 75 },
      { x: 40, y: 70 },
      { x: 35, y: 65 },
      { x: 30, y: 60 },
      { x: 25, y: 55 },
      { x: 20, y: 50 },
      { x: 25, y: 45 },
      { x: 30, y: 40 },
      { x: 35, y: 35 },
      { x: 40, y: 30 },
      { x: 45, y: 25 },
      { x: 50, y: 20 },
      { x: 55, y: 25 },
      { x: 60, y: 30 },
      { x: 65, y: 35 },
      { x: 70, y: 40 },
      { x: 75, y: 45 },
      { x: 80, y: 50 },
      { x: 85, y: 55 },
      { x: 90, y: 60 },
      { x: 85, y: 65 },
      { x: 80, y: 70 },
      { x: 75, y: 75 },
      { x: 70, y: 80 },
      { x: 65, y: 75 },
      { x: 60, y: 70 },
      { x: 55, y: 65 },
      { x: 50, y: 60 },
      { x: 45, y: 55 },
      { x: 40, y: 50 },
      { x: 35, y: 45 },
      { x: 30, y: 40 },
      { x: 25, y: 35 },
      { x: 20, y: 30 },
      { x: 15, y: 20 },
    ];

    // Store previous positions for trail
    const trailHistory: Array<{ x: number; y: number }> = [];
    const maxTrailLength = 8;

    const totalDuration = 25; // seconds
    const animationDuration = totalDuration * 1000; // milliseconds

    const animate = () => {
      const startTime = Date.now();
      
      const updatePosition = () => {
        const elapsed = (Date.now() - startTime) % animationDuration;
        const progress = elapsed / animationDuration;
        
        // Find the current segment
        const segmentIndex = Math.floor(progress * path.length);
        const nextIndex = (segmentIndex + 1) % path.length;
        const currentPoint = path[segmentIndex];
        const nextPoint = path[nextIndex];
        
        // Calculate interpolation within the segment
        const segmentProgress = (progress * path.length) % 1;
        
        // Smooth interpolation
        const easeInOutCubic = (t: number) => 
          t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        
        const easedProgress = easeInOutCubic(segmentProgress);
        
        const x = currentPoint.x + (nextPoint.x - currentPoint.x) * easedProgress;
        const y = currentPoint.y + (nextPoint.y - currentPoint.y) * easedProgress;
        
        // Update cursor position
        if (cursorRef.current) {
          cursorRef.current.style.left = `${x}%`;
          cursorRef.current.style.top = `${y}%`;
        }
        
        // Update trail history
        trailHistory.push({ x, y });
        if (trailHistory.length > maxTrailLength) {
          trailHistory.shift();
        }
        
        // Update trail dots
        if (trailRef.current) {
          const trailPoints = trailRef.current.querySelectorAll('.cursor-trail-dot');
          trailPoints.forEach((dot, index) => {
            const historyIndex = trailHistory.length - 1 - index;
            if (historyIndex >= 0 && historyIndex < trailHistory.length) {
              const trailPoint = trailHistory[historyIndex];
              if (dot instanceof HTMLElement) {
                dot.style.left = `${trailPoint.x}%`;
                dot.style.top = `${trailPoint.y}%`;
                dot.style.opacity = `${Math.max(0, 1 - index * 0.12)}`;
              }
            }
          });
        }
        
        requestAnimationFrame(updatePosition);
      };
      
      updatePosition();
    };
    
    animate();
  }, []);

  return (
    <>
      {/* Cursor */}
      <div
        ref={cursorRef}
        className="cursor-pointer-element"
        style={{
          position: 'absolute',
          zIndex: 20,
        }}
      >
        <div className="cursor-pointer">
          <div className="cursor-pointer-inner" />
        </div>
      </div>
      
      {/* Trail */}
      <div
        ref={trailRef}
        className="cursor-trail"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 19,
        }}
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="cursor-trail-dot"
            style={{
              position: 'absolute',
              width: `${4 - i * 0.3}px`,
              height: `${4 - i * 0.3}px`,
              borderRadius: '50%',
              background: `hsl(var(--primary) / ${0.5 - i * 0.05})`,
              transition: 'all 0.15s linear',
            }}
          />
        ))}
      </div>
      
      {/* Click effects - positioned at key points along the path */}
      <div className="cursor-click-effects">
        <div
          className="cursor-click-effect"
          style={{
            left: '35%',
            top: '30%',
            '--click-delay': '2s',
          } as React.CSSProperties}
        />
        <div
          className="cursor-click-effect"
          style={{
            left: '65%',
            top: '60%',
            '--click-delay': '12s',
          } as React.CSSProperties}
        />
        <div
          className="cursor-click-effect"
          style={{
            left: '50%',
            top: '75%',
            '--click-delay': '22s',
          } as React.CSSProperties}
        />
      </div>
    </>
  );
}

